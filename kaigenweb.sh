#!/usr/bin/env bash
# Kaigen Web for Debian 13: bash kaigenweb.sh
set -Eeuo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export DEBIAN_FRONTEND=noninteractive LC_ALL=C
readonly REPO=kaigendev/Kaigen
readonly APP=/opt/kaigenweb CFG=/etc/kaigenweb STATE=/var/lib/kaigenweb
readonly UNIT=kaigenweb-installer.service
readonly ACME_SHA=c7d68b021cfd6380ea83a82962abde5b484779fee0b97d38681dfa1396bbc8d7
readonly SELF="$(readlink -f -- "${BASH_SOURCE[0]}")"
UI_LANG=en MODE='' HOST='' ONION='' USE_TOR=n VERSION='' BUILD='' PERSONAL='' COMPLETE=n
DISK_MIB=256 RAM_MIB=128 STAGE=0 ACTION=install STATUS=idle CODE_HASH='' SCHEMA=2
OLD_BUILD='' OLD_VERSION='' NEW_BUILD='' PUBLIC_READY=n
TLS_MODE=auto TLS_PENDING=n TLS_CERT_PATH='' TLS_KEY_PATH=''
FRONT_INSPECT=n
TMP='' IS_WORKER=n CHECK_STARTED=n UPDATE_PENDING=n UI_LOCKED=n WORKER_LOCKED=n
TAIL_PID='' WAIT_PID='' AUTH_DIR=''

# English templates form the English message set; I18N_RU supplies Russian.
declare -Ar I18N_RU=(
  ['Input ended.']='Ввод завершён.'
  ['Update failed; restoring the previous release.']='Обновление не удалось; восстанавливаем предыдущий выпуск.'
  ['Installation stopped at line %s. Run this script again to retry or remove it.']='Установка остановлена на строке %s. Запустите скрипт снова, чтобы повторить попытку или удалить Kaigen Web.'
  ['Run as root: sudo bash kaigenweb.sh']='Запустите с правами root: sudo bash kaigenweb.sh'
  ['Debian 13 is required.']='Требуется Debian 13.'
  ['The official Web bundle requires amd64.']='Официальная сборка Web требует архитектуру amd64.'
  ['A running systemd host is required.']='Требуется система с работающим systemd.'
  ['System: %s (%s)']='Система: %s (%s)'
  ['Present: %s']='Найдено: %s'
  ['Another Kaigen Web installer is running.']='Другой установщик Kaigen Web уже запущен.'
  ['Invalid GitHub release tag.']='Недопустимая метка выпуска GitHub.'
  ['Web bundle is missing or ambiguous']='Архив Web отсутствует или найдено несколько подходящих архивов'
  ['Downloading official Kaigen Web %s...']='Загружаем официальный выпуск Kaigen Web %s...'
  ['Unsafe archive paths.']='Архив содержит небезопасные пути.'
  ['Invalid Web build identity.']='Недопустимый идентификатор сборки Web.'
  ['UI identity mismatch.']='Идентификатор интерфейса не совпадает с идентификатором сборки.'
  ['This release directory already exists; refusing to overwrite it.']='Каталог этого выпуска уже существует; перезапись отменена.'
  ['Backend ready on port %s.']='Серверная часть готова на порту %s.'
  ['Backend did not become ready.']='Серверная часть не перешла в состояние готовности.'
  ['Workspace challenge received (difficulty=%s).']='Получено задание для создания рабочего пространства (сложность=%s).'
  ['Unexpected installer proof difficulty.']='Неожиданная сложность задания для установщика.'
  ['Solving workspace proof: %s attempts']='Вычисляем подтверждение для рабочего пространства: попыток — %s'
  ['Checking workspace creation and deletion...']='Проверяем создание и удаление рабочего пространства...'
  ['Workspace check port 18787 is already in use.']='Порт 18787 для проверки рабочего пространства уже занят.'
  ['Another workspace check service is active.']='Другая служба проверки рабочего пространства уже работает.'
  ['Workspace check service exited.']='Служба проверки рабочего пространства завершила работу.'
  ['Workspace check listener is not owned by its service.']='Слушающий сокет проверки рабочего пространства не принадлежит её службе.'
  ['Test workspace storage remains.']='Хранилище проверочного рабочего пространства не удалено.'
  ['Tor did not create an onion address.']='Tor не создал onion-адрес.'
  ['%s is not enabled and active.']='Служба %s не включена для автозапуска или не работает.'
  ['The Web entry is not served as HTML.']='Веб-страница входа отдаётся не в формате HTML.'
  ['Personal registration page is exposed.']='Страница регистрации доступна в личном режиме.'
  ['Personal registration API is exposed.']='API регистрации доступен в личном режиме.'
  ['Waiting for Tor and checking the onion URL...']='Ожидаем Tor и проверяем onion-адрес...'
  ['The onion URL is not reachable through Tor.']='Onion-адрес недоступен через Tor.'
  ['The onion service accepted an unrelated Origin.']='Onion-служба приняла запрос с посторонним заголовком Origin.'
  ['Open: %s']='Откройте: %s'
  ['Tor: %s']='Tor: %s'
  ['Removal would also remove unrelated package %s.']='Удаление также затронет посторонний пакет %s.'
  ['Removing Kaigen Web, all its workspaces, and components added by this installer...']='Удаляем Kaigen Web, все его рабочие пространства и компоненты, добавленные этим установщиком...'
  ['Package %s remains installed.']='Пакет %s остался установленным.'
  ['Managed paths remain after removal.']='После удаления остались пути, которыми управляет установщик.'
  ['Welcome to Kaigen Web. This installs the latest official Web release, its dependencies, Nginx and HTTPS.']='Добро пожаловать в Kaigen Web. Будут установлены последний официальный выпуск Web, его зависимости, Nginx и HTTPS.'
  ['1) Personal: one private workspace. 2) Service: users can create workspaces.']='1) Личный режим: одно приватное рабочее пространство. 2) Сервис: пользователи могут создавать рабочие пространства.'
  ['Choose mode [1/2]: ']='Выберите режим [1/2]: '
  ['Choose 1 or 2.']='Выберите 1 или 2.'
  ['Public domain or IPv4 address (no scheme or path): ']='Публичное доменное имя или IPv4-адрес (без схемы и пути): '
  ['Invalid hostname or IPv4 address.']='Недопустимое имя узла или IPv4-адрес.'
  ['Enable Tor onion access? [y/N]: ']='Включить доступ через Tor onion? [y/N]: '
  ['Unmanaged Kaigen paths already exist.']='Уже существуют пути Kaigen, не принадлежащие этой установке.'
  ['A required port is already in use. No existing service was changed.']='Один из необходимых портов уже занят. Существующие службы не изменены.'
  ['The kaigenweb account already exists.']='Учётная запись kaigenweb уже существует.'
  ['Workspace password (save it now): %s']='Пароль рабочего пространства (сохраните его сейчас): %s'
  ['Already up to date: %s']='Уже установлен последний выпуск: %s'
  ['Kaigen Web is already installed.']='Kaigen Web уже установлен.'
  ['1) Update Kaigen and packages  2) Uninstall (erase all data)  3) Reinstall (erase all data)  4) Exit']='1) Обновить Kaigen и пакеты  2) Удалить (стереть все данные)  3) Переустановить (стереть все данные)  4) Выход'
  ['Choose [1/2/3/4]: ']='Выберите [1/2/3/4]: '
  ['Installation is incomplete. Choose Reinstall or Uninstall.']='Установка не завершена. Выберите переустановку или удаление.'
  ['This permanently deletes ALL Kaigen workspaces. Type DELETE: ']='Это безвозвратно удалит ВСЕ рабочие пространства Kaigen. Введите DELETE: '
  ['Removal cancelled.']='Удаление отменено.'
  ['Choose 1, 2, 3 or 4.']='Выберите 1, 2, 3 или 4.'
  ['ERROR: %s']='ОШИБКА: %s'
  ['Unsafe installer state: %s']='Небезопасное состояние установщика: %s'
  ['Invalid installer state.']='Некорректное состояние установщика.'
  ['Invalid package manifest.']='Некорректный список пакетов установщика.'
  ['Completed stage: %s']='Этап уже завершён: %s'
  ['Starting stage %s: %s']='Начинается этап %s: %s'
  ['Finished stage %s: %s']='Завершён этап %s: %s'
  ['Operation stopped. Run the installer again to continue or remove its data.']='Операция остановлена. Запустите скрипт снова, чтобы продолжить или удалить данные установки.'
  ['Administrator rights are required.']='Необходимы права администратора.'
  ['1) sudo (your password)  2) su (root password): ']='1) sudo (ваш пароль)  2) su (пароль root): '
  ['Neither sudo nor su is available.']='Не найдены ни sudo, ни su.'
  ['Sudo authorization failed. No installation was started.']='Не удалось получить права через sudo. Установка не начата.'
  ['Waiting for the package manager...']='Ожидаем завершения работы пакетного менеджера...'
  ['The package manager is busy. Retry later.']='Пакетный менеджер занят. Повторите запуск позже.'
  ['Installed release validation failed.']='Проверка установленного выпуска не пройдена.'
  ['Invalid workspace identifier.']='Некорректный идентификатор пространства.'
  ['Personal workspace recovery requires manual inspection.']='Состояние опубликованного личного пространства требует проверки; автоматическое пересоздание запрещено.'
  ['Reusing the existing certificate.']='Используем уже полученный сертификат.'
  ['Packages']='Пакеты'
  ['Official Web release']='Официальный выпуск Web'
  ['Backend and memory storage']='Серверная часть и хранилище в памяти'
  ['Workspace creation and deletion']='Создание и удаление проверочного пространства'
  ['Personal workspace']='Личное пространство'
  ['Web server']='Веб-сервер'
  ['HTTPS certificate']='Сертификат HTTPS'
  ['Public routes and Tor']='Внешний доступ и Tor'
  ['Final service and API checks']='Итоговая проверка служб и API'
  ['Installation completed.']='Установка завершена.'
  ['Disk limit per workspace, MiB [%s]: ']='Лимит на диске для одного пространства, МиБ [%s]: '
  ['RAM limit per workspace, MiB [%s]: ']='Лимит RAM для одного пространства, МиБ [%s]: '
  ['Limits must be positive whole MiB values.']='Лимиты должны быть положительными целыми числами в МиБ.'
  ['An unrelated installer service exists.']='Найдена посторонняя служба с именем установщика.'
  ['Working; you may reconnect without restarting the installation.']='Работа продолжается; можно переподключиться без повторной установки.'
  ['Operation failed. Log: %s']='Операция не завершена. Журнал: %s'
  ['Action log: %s']='Журнал действий: %s'
  ['Worker started: %s']='Рабочий процесс запущен: %s'
  ['Installer snapshot validation failed.']='Проверка сохранённой копии установщика не пройдена.'
  ['Unknown option.']='Неизвестный параметр.'
  ['Another installer control session is open.']='Уже открыт другой сеанс управления установщиком.'
  ['An unfinished installation was found.']='Найдена незавершённая установка.'
  ['1) Continue installation  2) Remove all unfinished data: ']='1) Продолжить установку  2) Удалить все данные незавершённой установки: '
  ["1) Let's Encrypt  2) Existing certificate  3) Self-signed certificate  4) Stop"]='1) Let’s Encrypt  2) Существующий сертификат  3) Самоподписанный сертификат  4) Остановить'
  ['Choose HTTPS certificate [1/2/3/4] [%s]: ']='Выберите сертификат HTTPS [1/2/3/4] [%s]: '
  ['Full-chain PEM path [%s]: ']='Путь к PEM-файлу цепочки сертификатов [%s]: '
  ['Unencrypted private-key PEM path [%s]: ']='Путь к PEM-файлу незашифрованного приватного ключа [%s]: '
  ['Both PEM files must exist at absolute paths.']='Укажите существующие PEM-файлы абсолютными путями.'
  ['A self-signed certificate encrypts traffic, but browsers will show a trust warning.']='Самоподписанный сертификат шифрует трафик, но браузер покажет предупреждение о доверии.'
  ['Generate and use a self-signed certificate? [y/N]: ']='Создать и подключить самоподписанный сертификат? [y/N]: '
  ['Self-signed certificate was not selected.']='Самоподписанный сертификат не выбран.'
  ['Run this script again when you want to continue.']='Запустите этот скрипт снова, когда захотите продолжить.'
  ['HTTPS setup did not finish. Choose another certificate option or stop with progress saved.']='Настройка HTTPS не завершена. Выберите другой вариант сертификата или остановитесь с сохранением прогресса.'
  ['Generating a self-signed HTTPS certificate...']='Создаём самоподписанный сертификат HTTPS...'
  ['Importing the selected certificate and key...']='Копируем выбранный сертификат и ключ...'
  ['The certificate/key pair is invalid, expired, mismatched, encrypted, or does not cover this host.']='Пара сертификат/ключ некорректна, просрочена, не совпадает, зашифрована или не подходит этому адресу.'
  ['The self-signed certificate could not be generated.']='Не удалось создать самоподписанный сертификат.'
  ['ACME renewal is still active.']='Автопродление ACME ещё работает.'
  ['TLS certificate type: %s']='Тип сертификата TLS: %s'
  ['TLS certificate expires: %s']='Сертификат TLS действует до: %s'
  ['TLS SHA-256 fingerprint: %s']='Отпечаток TLS SHA-256: %s'
  ['Built-in ACME renewal is disabled for this certificate.']='Встроенное автопродление ACME для этого сертификата отключено.'
  ['Browser trust for an existing certificate depends on its issuer.']='Доверие браузера к существующему сертификату зависит от его издателя.'
)

text() {
  local template=$1; shift
  if [[ $UI_LANG == ru && -v I18N_RU[$template] ]]; then template=${I18N_RU[$template]}; fi
  printf -- "$template" "$@"
}
say() { text "$@"; printf '\n'; }
die() { printf '\n'; text 'ERROR: %s' "$(text "$@")" >&2; printf '\n' >&2; exit 1; }
ask() { local prompt=$1 variable=$2; shift 2; read -r -p "$(text "$prompt" "$@")" "$variable" || die 'Input ended.'; }
fetch() { curl -fLsS --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 20 "$@"; }
packages() { dpkg-query -W -f='${binary:Package} ${db:Status-Status}\n' | awk '$2=="installed"{sub(/:amd64$/,"",$1); print $1}' | sort; }
secure_dir() {
  [[ -d $1 && ! -L $1 && $(stat -c %u "$1") == 0 ]] || die 'Unsafe installer state: %s' "$1"
  local mode; mode=$(stat -c %a "$1")
  (( (8#$mode & 022) == 0 )) || die 'Unsafe installer state: %s' "$1"
}
secure_file() {
  [[ -f $1 && ! -L $1 && $(stat -c %u "$1") == 0 ]] || die 'Unsafe installer state: %s' "$1"
  local mode; mode=$(stat -c %a "$1")
  (( (8#$mode & 077) == 0 )) || die 'Unsafe installer state: %s' "$1"
}
save_state() {
  local name temporary="$STATE/settings.new"
  [[ ! -L $temporary ]] || die 'Unsafe installer state: %s' "$temporary"
  : > "$temporary"; chmod 600 "$temporary"
  for name in SCHEMA UI_LANG MODE HOST USE_TOR ONION VERSION BUILD PERSONAL COMPLETE DISK_MIB RAM_MIB STAGE ACTION STATUS CODE_HASH OLD_BUILD OLD_VERSION NEW_BUILD PUBLIC_READY TLS_MODE TLS_PENDING TLS_CERT_PATH TLS_KEY_PATH; do
    printf '%s=%s\n' "$name" "${!name}" >> "$temporary"
  done
  mv -f -- "$temporary" "$STATE/settings"
  sync -f "$STATE/settings"
}
load_state() {
  secure_dir "$STATE"; secure_file "$STATE/settings"
  local key value
  while IFS='=' read -r key value; do
    case "$key" in
      SCHEMA|UI_LANG|MODE|HOST|USE_TOR|ONION|VERSION|BUILD|PERSONAL|COMPLETE|DISK_MIB|RAM_MIB|STAGE|ACTION|STATUS|CODE_HASH|OLD_BUILD|OLD_VERSION|NEW_BUILD|PUBLIC_READY|TLS_MODE|TLS_PENDING|TLS_CERT_PATH|TLS_KEY_PATH)
        [[ $value != *$'\r'* && $value != *$'\n'* ]] || die 'Invalid installer state.'
        printf -v "$key" '%s' "$value";;
      *) die 'Invalid installer state.';;
    esac
  done < "$STATE/settings"
  [[ $SCHEMA == 2 && $UI_LANG =~ ^(ru|en)$ && $MODE =~ ^(personal|service)$ && $USE_TOR =~ ^(y|n)$ ]] || die 'Invalid installer state.'
  [[ $HOST =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ && $HOST != *..* ]] || die 'Invalid installer state.'
  [[ $STAGE =~ ^[0-9]{1,2}$ && $DISK_MIB =~ ^[1-9][0-9]{0,6}$ && $RAM_MIB =~ ^[1-9][0-9]{0,6}$ ]] || die 'Invalid installer state.'
  [[ $ACTION =~ ^(install|update|remove)$ && $STATUS =~ ^(idle|running|failed|complete)$ && $COMPLETE =~ ^(y|n)$ ]] || die 'Invalid installer state.'
  [[ $CODE_HASH =~ ^[a-f0-9]{64}$ && $PUBLIC_READY =~ ^(y|n)$ ]] || die 'Invalid installer state.'
  for key in BUILD OLD_BUILD NEW_BUILD; do
    value=${!key}; [[ -z $value || $value =~ ^[A-Za-z0-9][A-Za-z0-9._-]{11,79}$ ]] || die 'Invalid installer state.'
  done
  [[ -z $VERSION || $VERSION =~ ^v[0-9][A-Za-z0-9._-]*$ ]] || die 'Invalid installer state.'
  [[ -z $OLD_VERSION || $OLD_VERSION =~ ^v[0-9][A-Za-z0-9._-]*$ ]] || die 'Invalid installer state.'
  [[ -z $PERSONAL || $PERSONAL =~ ^[A-Za-z0-9_-]{40,80}$ ]] || die 'Invalid installer state.'
  [[ -z $ONION || $ONION =~ ^[a-z2-7]{56}\.onion$ ]] || die 'Invalid installer state.'
  [[ $TLS_MODE =~ ^(auto|existing|selfsigned)$ && $TLS_PENDING =~ ^(y|n)$ ]] || die 'Invalid installer state.'
  for key in TLS_CERT_PATH TLS_KEY_PATH; do
    value=${!key}; [[ -z $value || $value == /* ]] || die 'Invalid installer state.'
  done
}
log_action() {
  printf '[%s] ' "$(date -u '+%FT%TZ')"
  say "$@"
}
stage() {
  local number=$1 label=$2; shift 2
  if (( STAGE >= number )); then log_action 'Completed stage: %s' "$(text "$label")"; return; fi
  log_action 'Starting stage %s: %s' "$number" "$(text "$label")"
  STATUS=running; save_state
  "$@"
  STAGE=$number; save_state
  log_action 'Finished stage %s: %s' "$number" "$(text "$label")"
  sync -f "$STATE/install.log"
}
cleanup() {
  local result=$?
  [[ -z $TAIL_PID ]] || { kill "$TAIL_PID" 2>/dev/null || true; wait "$TAIL_PID" 2>/dev/null || true; }
  if [[ $IS_WORKER == y ]]; then
    if [[ $UPDATE_PENDING == y && -n $OLD_BUILD && -f $STATE/nginx.previous ]]; then
      say 'Update failed; restoring the previous release.' >&2
      systemctl stop kaigenweb.service || true
      ln -sfn "$APP/releases/$OLD_BUILD" "$APP/current"
      cp "$STATE/nginx.previous" "$CFG/nginx.conf"
      systemctl start kaigenweb.service || true
      systemctl reload kaigenweb-nginx.service || true
      if [[ -n $NEW_BUILD && $NEW_BUILD != "$OLD_BUILD" && $(readlink -f "$APP/current") == "$APP/releases/$OLD_BUILD" ]]; then rm -rf -- "$APP/releases/$NEW_BUILD"; fi
      BUILD=$OLD_BUILD VERSION=$OLD_VERSION STAGE=0
    fi
    if [[ $CHECK_STARTED == y ]]; then
      systemctl stop kaigenweb-check.service 2>/dev/null || true
      systemctl reset-failed kaigenweb-check.service 2>/dev/null || true
      rm -rf -- "$STATE/check" "$STATE/check.env" /run/kaigenweb/check
    fi
    if ((result != 0)) && [[ -d $STATE && -f $STATE/settings ]]; then
      STATUS=failed; save_state || true
      log_action 'Operation stopped. Run the installer again to continue or remove its data.' >&2
    fi
  fi
  [[ -z $AUTH_DIR ]] || rm -rf -- "$AUTH_DIR"
  if [[ ! -d $STATE ]]; then
    [[ $UI_LOCKED != y ]] || rm -f /run/kaigenweb-ui.lock
    [[ $WORKER_LOCKED != y ]] || rm -f /run/kaigenweb-install.lock
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

select_language() {
  printf '1) Русский\n2) English\n'
  local selection; read -r -p 'Язык / Language [1/2]: ' selection || exit 1
  case $selection in 1) UI_LANG=ru;; 2) UI_LANG=en;; *) printf 'Выберите 1 или 2 / Choose 1 or 2.\n' >&2; exit 1;; esac
}
elevate() {
  [[ $EUID != 0 ]] || return 0
  local method='' digest bootstrap
  say 'Administrator rights are required.'
  if command -v sudo >/dev/null && command -v su >/dev/null; then
    ask '1) sudo (your password)  2) su (root password): ' method
  elif command -v sudo >/dev/null; then method=1
  elif command -v su >/dev/null; then method=2
  else die 'Neither sudo nor su is available.'; fi
  digest=$(sha256sum < "$SELF"); digest=${digest%% *}
  bootstrap=$(cat <<'ROOT_BOOTSTRAP'
set -Eeuo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ $EUID == 0 && $2 =~ ^[a-f0-9]{64}$ && $3 =~ ^(ru|en)$ && $4 =~ ^(y|n)$ && -f $1 ]] || exit 1
snapshot=$(mktemp -d /run/kaigenweb-auth.XXXXXXXX)
trap 'rm -rf -- "$snapshot"' EXIT
cp -- "$1" "$snapshot/kaigenweb.sh"
chmod 700 "$snapshot/kaigenweb.sh"
actual=$(sha256sum < "$snapshot/kaigenweb.sh"); actual=${actual%% *}
[[ $actual == "$2" ]] || { printf 'Installer changed during authorization.\n' >&2; exit 1; }
args=(--language "$3"); [[ $4 != y ]] || args+=(--inspect)
/bin/bash --noprofile --norc -p -- "$snapshot/kaigenweb.sh" "${args[@]}"
ROOT_BOOTSTRAP
)
  case $method in
    1)
      sudo -v || die 'Sudo authorization failed. No installation was started.'
      exec sudo -n -- /usr/bin/env -i HOME=/root USER=root LOGNAME=root PATH="$PATH" \
        /bin/bash --noprofile --norc -p -c "$bootstrap" kaigenweb-bootstrap "$SELF" "$digest" "$UI_LANG" "$FRONT_INSPECT";;
    2)
      exec /usr/bin/su --login --pty --shell /bin/bash -- root --noprofile --norc -p \
        -c "$bootstrap" kaigenweb-bootstrap "$SELF" "$digest" "$UI_LANG" "$FRONT_INSPECT";;
    *) die 'Choose 1 or 2.';;
  esac
}
check_system() {
  [[ $EUID == 0 ]] || die 'Administrator rights are required.'
  source /etc/os-release
  [[ $ID == debian && $VERSION_ID == 13 ]] || die 'Debian 13 is required.'
  [[ $(dpkg --print-architecture) == amd64 ]] || die 'The official Web bundle requires amd64.'
  [[ -d /run/systemd/system ]] || die 'A running systemd host is required.'
}
inventory() {
  say 'System: %s (%s)' "$PRETTY_NAME" "$(dpkg --print-architecture)"
  local found=n item
  for item in "$APP" "$CFG" "$STATE" /run/kaigenweb /run/kaigenweb-install.lock \
    /etc/systemd/system/kaigenweb{,-nginx,-tor,-acme}.service /etc/systemd/system/kaigenweb-acme.timer \
    /etc/systemd/system/run-kaigenweb.mount /tmp/kaigenweb.*; do
    if [[ -e $item ]]; then say 'Present: %s' "$item"; found=y; fi
  done
  sha256sum -- "$SELF"
  [[ $found != n ]] || say 'CLEAN_HOST_PASS managedPathsAbsent=true'
}

write_backend() {
  cat > /etc/systemd/system/run-kaigenweb.mount <<'EOF'
[Unit]
Description=Kaigen Web memory storage without swap
[Mount]
What=tmpfs
Where=/run/kaigenweb
Type=tmpfs
Options=mode=0700,uid=kaigenweb,gid=kaigenweb,noswap,nodev,nosuid,noexec
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now run-kaigenweb.mount
  cat > "$CFG/backend.env" <<EOF
LD_LIBRARY_PATH=$APP/current/lib/Kaigen
KAIGEN_WEB_DEPLOYMENT_MODE=$MODE
KAIGEN_WEB_BIND=127.0.0.1:8787
KAIGEN_WEB_ORIGIN=https://$HOST
KAIGEN_WEB_DATA_ROOT=$STATE/disk
KAIGEN_WEB_RAM_ROOT=/run/kaigenweb/ram
KAIGEN_WEB_ACTIVE_ROOT=/run/kaigenweb/active
KAIGEN_WEB_RESOURCE_ROOT=$APP/current
KAIGEN_WEB_LEASE_HOURS=72
KAIGEN_WEB_PROOF_DIFFICULTY=18
EOF
  if [[ $MODE == service ]]; then
    printf 'KAIGEN_WEB_DISK_QUOTA_BYTES=%s\nKAIGEN_WEB_RAM_QUOTA_BYTES=%s\n' "$((DISK_MIB*1048576))" "$((RAM_MIB*1048576))" >> "$CFG/backend.env"
  fi
  cat > /etc/systemd/system/kaigenweb.service <<EOF
[Unit]
Description=Kaigen Web
After=network.target run-kaigenweb.mount
Requires=run-kaigenweb.mount
[Service]
User=kaigenweb
Group=kaigenweb
EnvironmentFile=$CFG/backend.env
ExecStart=$APP/current/bin/kaigen-webd
Restart=on-failure
RestartSec=3
TimeoutStopSec=90
LimitMEMLOCK=infinity
AmbientCapabilities=CAP_IPC_LOCK
CapabilityBoundingSet=CAP_IPC_LOCK
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=$STATE /run/kaigenweb
UMask=0077
[Install]
WantedBy=multi-user.target
EOF
}

wait_backend() {
  local port=$1 unit=kaigenweb.service substate
  [[ $port != 18787 ]] || unit=kaigenweb-check.service
  for ((i=0;i<60;i++)); do
    if curl --noproxy '*' -fsS --max-time 3 "http://127.0.0.1:$port/healthz" > /dev/null 2>&1 &&
       curl --noproxy '*' -fsS --max-time 3 "http://127.0.0.1:$port/readyz" > /dev/null 2>&1; then say 'Backend ready on port %s.' "$port" >&2; return; fi
    substate=$(systemctl show -p SubState --value "$unit")
    [[ $substate != auto-restart && $substate != failed ]] || break
    sleep 1
  done
  journalctl -u kaigenweb.service -u kaigenweb-check.service -n 20 --no-pager >&2
  die 'Backend did not become ready.'
}

api() {
  local response
  if ! response=$(curl --noproxy '*' --fail-with-body -sS --max-time 120 -H "Origin: https://$HOST" -H 'Content-Type: application/json' \
    -H "X-Kaigen-Client-Build: $BUILD" "${API_EXTRA[@]}" \
    "http://127.0.0.1:$API_PORT/api/v1/$1" --data-binary @- <<< "$2"); then
    printf '%s\n' "$response" >&2; return 1
  fi
  printf '%s\n' "$response"
}

create_workspace() {
  local password=$1 challenge salt difficulty hash nonce=0
  challenge=$(api initializer/challenge '{}')
  salt=$(jq -er .salt <<< "$challenge")
  difficulty=$(jq -er .difficulty <<< "$challenge")
  say 'Workspace challenge received (difficulty=%s).' "$difficulty" >&2
  [[ $difficulty == 12 ]] || die 'Unexpected installer proof difficulty.'
  while :; do
    hash=$(printf '%s:%s' "$salt" "$nonce" | openssl dgst -sha256)
    [[ ${hash##* } != 000* ]] || break
    ((nonce+=1))
    if ((nonce % 1000 == 0)); then say 'Solving workspace proof: %s attempts' "$nonce" >&2; fi
  done
  api workspaces "$(printf '{"storageMode":"disk","accessPassword":"%s","language":"%s","proof":{"challengeId":"%s","nonce":%s}}' "$password" "$UI_LANG" "$(jq -r .challengeId <<< "$challenge")" "$nonce")" | jq -er .identifier
}

check_workspace() {
  say 'Checking workspace creation and deletion...'
  if systemctl is-active --quiet kaigenweb-check.service; then
    secure_file "$STATE/check.owner"
    [[ $(systemctl show -p User --value kaigenweb-check.service) == kaigenweb && $(systemctl show -p ExecStart --value kaigenweb-check.service) == *"$APP/current/bin/kaigen-webd"* ]] || die 'Another workspace check service is active.'
    systemctl stop kaigenweb-check.service
  fi
  rm -rf -- "$STATE/check" "$STATE/check.env" /run/kaigenweb/check
  if ss -ltnH '( sport = :18787 )' | read -r _; then die 'Workspace check port 18787 is already in use.'; fi
  if systemctl is-active --quiet kaigenweb-check.service; then die 'Another workspace check service is active.'; fi
  systemctl reset-failed kaigenweb-check.service 2>/dev/null || true
  mkdir -p "$STATE/check/disk" /run/kaigenweb/check/{ram,active}
  chown -R kaigenweb:kaigenweb "$STATE/check"
  chown -R kaigenweb:kaigenweb /run/kaigenweb/check
  sed -e 's/:8787$/:18787/' -e "s|$STATE/disk|$STATE/check/disk|" \
    -e 's|/run/kaigenweb/ram|/run/kaigenweb/check/ram|' -e 's|/run/kaigenweb/active|/run/kaigenweb/check/active|' \
    -e 's/PROOF_DIFFICULTY=18/PROOF_DIFFICULTY=12/' "$CFG/backend.env" > "$STATE/check.env"
  printf '%s\n' "$CODE_HASH" > "$STATE/check.owner"; sync -f "$STATE/check.owner"
  systemd-run --quiet --collect --unit=kaigenweb-check --property=User=kaigenweb \
    --property="EnvironmentFile=$STATE/check.env" --property=LimitMEMLOCK=infinity \
    --property=AmbientCapabilities=CAP_IPC_LOCK "$APP/current/bin/kaigen-webd"
  CHECK_STARTED=y
  wait_backend 18787
  systemctl is-active --quiet kaigenweb-check.service || die 'Workspace check service exited.'
  local check_pid
  check_pid=$(systemctl show -p MainPID --value kaigenweb-check.service)
  ss -ltnpH '( sport = :18787 )' | grep -q "pid=$check_pid," || die 'Workspace check listener is not owned by its service.'
  local API_PORT=18787 API_EXTRA=() password identifier key login csrf selector
  password=$(openssl rand -hex 18)
  identifier=$(create_workspace "$password")
  key=$(openssl ecparam -name prime256v1 -genkey 2>/dev/null | openssl ec -pubout -outform DER 2>/dev/null | base64 -w0 | tr '+/' '-_' | tr -d '=')
  login=$(api auth/password "$(printf '{"identifier":"%s","password":"%s","publicKey":"%s"}' "$identifier" "$password" "$key")")
  csrf=$(jq -er .csrfToken <<< "$login")
  selector=$(jq -er .workspaceSelector <<< "$login")
  API_EXTRA=(-H "Cookie: __Host-kaigen-device=$(jq -er .deviceId <<< "$login")" -H "X-Kaigen-Csrf: $csrf" -H "X-Kaigen-Workspace: $selector")
  api workspaces/destroy '{"explicitConfirmation":true}' | jq -e '.destroyed==true' >/dev/null
  API_EXTRA=()
  api workspaces/lookup "$(jq -nc --arg id "$identifier" '{identifier:$id}')" | jq -e '.exists==false' >/dev/null
  [[ -z $(find "$STATE/check/disk" -mindepth 1 -maxdepth 1 -type d -print -quit) ]] || die 'Test workspace storage remains.'
  systemctl stop kaigenweb-check.service
  systemctl reset-failed kaigenweb-check.service 2>/dev/null || true
  rm -rf -- "$STATE/check" "$STATE/check.env" /run/kaigenweb/check
  CHECK_STARTED=n
  rm -f "$STATE/check.owner"
  say 'WORKSPACE_CHECK_PASS created=true deleted=true'
}

write_nginx() {
  local tls=${1:-no} origin=''
  cat > "$CFG/nginx.conf" <<EOF
user www-data;
worker_processes auto;
pid /run/kaigenweb-nginx.pid;
error_log $STATE/nginx/error.log;
events { worker_connections 1024; }
http {
 include /etc/nginx/mime.types;
 default_type application/octet-stream;
 access_log off;
 client_body_temp_path $STATE/nginx/body;
 proxy_temp_path $STATE/nginx/proxy;
 server {
  listen 80;
  server_name $HOST;
  location ^~ /.well-known/acme-challenge/ { root $STATE/acme-web; }
  location / { return $([[ $tls == yes ]] && echo "301 https://$HOST\$request_uri" || echo 503); }
 }
EOF
  if [[ $tls == yes ]]; then
    nginx_app_server 'listen 443 ssl default_server;' "https://$HOST" yes
    [[ $USE_TOR != y ]] || nginx_app_server 'listen 127.0.0.1:8089;' "http://$ONION" no
  fi
  echo '}' >> "$CFG/nginx.conf"
  /usr/sbin/nginx -t -c "$CFG/nginx.conf"
}

nginx_app_server() {
  local listen=$1 origin=$2 tls=$3
  cat >> "$CFG/nginx.conf" <<EOF
 server {
  $listen
  server_name $([[ $tls == yes ]] && echo "$HOST" || echo "$ONION");
  root $APP/current/ui;
  client_max_body_size 32m;
  add_header Cache-Control no-store always;
  add_header Referrer-Policy no-referrer always;
  add_header X-Content-Type-Options nosniff always;
  add_header X-Frame-Options DENY always;
  add_header Content-Security-Policy "default-src 'none'; base-uri 'none'; connect-src 'self'; font-src 'self' data:; form-action 'none'; frame-ancestors 'none'; frame-src 'none'; img-src 'self' blob: data:; manifest-src 'self'; media-src 'self' blob:; object-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; worker-src 'self'; require-trusted-types-for 'script'; trusted-types kaigen-spellcheck-worker kaigen-notifications-worker" always;
  add_header Cross-Origin-Opener-Policy same-origin always;
  add_header Cross-Origin-Resource-Policy same-origin always;
EOF
  if [[ $tls == yes ]]; then
    cat >> "$CFG/nginx.conf" <<EOF
  ssl_certificate $CFG/tls/fullchain.pem;
  ssl_certificate_key $CFG/tls/key.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
EOF
  else
    cat >> "$CFG/nginx.conf" <<EOF
  if (\$host != "$ONION") { return 403; }
EOF
  fi
  cat >> "$CFG/nginx.conf" <<EOF
  location = /api/v1/build-identity {
   default_type application/json;
   return 200 '{"status":"ok","buildId":"$BUILD"}';
  }
  location ~ "^/api/v1/install-manifest/[0-9a-f]{32}$" {
   proxy_pass http://127.0.0.1:8787;
  }
EOF
  if [[ $MODE == personal ]]; then
    cat >> "$CFG/nginx.conf" <<EOF
  location = /api/v1/workspaces { return 403; }
  location ^~ /api/v1/workspaces/import/ { return 403; }
  location = / { return 404; }
  location = /index.html { return 404; }
  location = /personal.html { return 404; }
  location = /space/$PERSONAL { alias $APP/current/ui/personal.html; default_type text/html; }
  location / { try_files \$uri =404; }
EOF
  else
    echo '  location / { try_files $uri $uri/ /index.html; }' >> "$CFG/nginx.conf"
  fi
  local path
  for path in /api/ /ws; do
    cat >> "$CFG/nginx.conf" <<EOF
  location $path {
   if (\$http_origin != "$origin") { return 403; }
EOF
    if [[ $path == /api/ ]]; then
      echo "   if (\$http_x_kaigen_client_build != \"$BUILD\") { return 426; }" >> "$CFG/nginx.conf"
    else
      echo "   if (\$arg_build != \"$BUILD\") { return 426; }" >> "$CFG/nginx.conf"
    fi
    cat >> "$CFG/nginx.conf" <<EOF
   proxy_set_header Origin "https://$HOST";
   proxy_set_header X-Real-IP \$remote_addr;
   proxy_set_header Host \$host;
   proxy_set_header X-Forwarded-Proto $([[ $tls == yes ]] && echo https || echo http);
   proxy_http_version 1.1;
   proxy_set_header Upgrade \$http_upgrade;
   proxy_set_header Connection "upgrade";
   proxy_read_timeout 300s;
   proxy_request_buffering off;
   proxy_pass http://127.0.0.1:8787;
  }
EOF
  done
  echo ' }' >> "$CFG/nginx.conf"
}

setup_nginx_service() {
  mkdir -p "$STATE/nginx/body" "$STATE/nginx/proxy" "$STATE/acme-web"
  chmod 755 "$STATE" "$STATE/acme-web"
  chown -R www-data:www-data "$STATE/nginx"
  cat > /etc/systemd/system/kaigenweb-nginx.service <<EOF
[Unit]
Description=Kaigen Web Nginx
After=network.target
[Service]
Type=simple
ExecStart=/usr/sbin/nginx -c $CFG/nginx.conf -g "daemon off;"
ExecReload=/usr/sbin/nginx -c $CFG/nginx.conf -s reload
Restart=on-failure
[Install]
WantedBy=multi-user.target
EOF
  write_nginx no
  systemctl daemon-reload
  systemctl enable --now kaigenweb-nginx.service
}

tls_pair_valid() {
  local cert=$1 key=$2 cert_public key_public names
  [[ -s $cert && -s $key ]] || return 1
  openssl x509 -in "$cert" -checkend 3600 -noout >/dev/null 2>&1 || return 1
  openssl pkey -in "$key" -passin pass: -noout >/dev/null 2>&1 || return 1
  cert_public=$(openssl x509 -in "$cert" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256) || return 1
  key_public=$(openssl pkey -in "$key" -passin pass: -pubout -outform DER | openssl dgst -sha256) || return 1
  [[ $cert_public == "$key_public" ]] || return 1
  if [[ $HOST =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    openssl x509 -in "$cert" -checkip "$HOST" -noout >/dev/null 2>&1 || return 1
  else
    names=$(openssl x509 -in "$cert" -noout -ext subjectAltName 2>/dev/null) || return 1
    [[ $names == *DNS:* ]] || return 1
    openssl x509 -in "$cert" -checkhost "$HOST" -noout >/dev/null 2>&1 || return 1
  fi
  openssl verify -partial_chain -purpose sslserver -trusted "$cert" "$cert" >/dev/null 2>&1
}
stop_acme_renewal() {
  systemctl disable --now kaigenweb-acme.timer 2>/dev/null || true
  systemctl stop kaigenweb-acme.service 2>/dev/null || true
  if systemctl is-active --quiet kaigenweb-acme.timer || systemctl is-active --quiet kaigenweb-acme.service; then
    die 'ACME renewal is still active.'
  fi
  rm -f /etc/systemd/system/kaigenweb-acme.{timer,service}
  systemctl daemon-reload
}
certificate() {
  TLS_PENDING=y; save_state
  mkdir -p "$CFG/tls" "$STATE/acme"
  local temporary profile=() result=0 subject issuer san
  if [[ $TLS_MODE == auto ]]; then
    if [[ ! -f $APP/acme.sh ]] || ! printf '%s  %s\n' "$ACME_SHA" "$APP/acme.sh" | sha256sum -c - >/dev/null 2>&1; then
      fetch -o "$APP/acme.sh.part" https://raw.githubusercontent.com/acmesh-official/acme.sh/3.1.6/acme.sh
      printf '%s  %s\n' "$ACME_SHA" "$APP/acme.sh.part" | sha256sum -c -
      mv "$APP/acme.sh.part" "$APP/acme.sh"; sync -f "$APP/acme.sh"
    fi
    if [[ -f $STATE/acme/${HOST}_ecc/$HOST.conf ]] && tls_pair_valid "$CFG/tls/fullchain.pem" "$CFG/tls/key.pem" &&
       openssl verify -untrusted "$CFG/tls/fullchain.pem" "$CFG/tls/fullchain.pem" >/dev/null 2>&1; then
      say 'Reusing the existing certificate.'
    else
      [[ ! $HOST =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || profile=(--certificate-profile shortlived --days 3)
      bash "$APP/acme.sh" --issue --server letsencrypt --home "$APP" --config-home "$STATE/acme" \
        --accountemail "" -d "$HOST" --webroot "$STATE/acme-web" --keylength ec-256 "${profile[@]}" || result=$?
      [[ $result == 0 || $result == 2 ]] || return "$result"
      bash "$APP/acme.sh" --install-cert --home "$APP" --config-home "$STATE/acme" -d "$HOST" --ecc \
        --key-file "$CFG/tls/key.pem" --fullchain-file "$CFG/tls/fullchain.pem" \
        --reloadcmd "/usr/sbin/nginx -t -c $CFG/nginx.conf && systemctl reload kaigenweb-nginx.service"
    fi
    tls_pair_valid "$CFG/tls/fullchain.pem" "$CFG/tls/key.pem" || die 'The certificate/key pair is invalid, expired, mismatched, encrypted, or does not cover this host.'
    setup_acme_renewal
  else
    stop_acme_renewal
    temporary=$(mktemp -d "$TMP/tls.XXXXXXXX")
    if [[ $TLS_MODE == existing ]]; then
      say 'Importing the selected certificate and key...'
      [[ -f $TLS_CERT_PATH && -f $TLS_KEY_PATH ]] || die 'Both PEM files must exist at absolute paths.'
      cp -- "$TLS_CERT_PATH" "$temporary/fullchain.pem"
      cp -- "$TLS_KEY_PATH" "$temporary/key.pem"
    else
      if tls_pair_valid "$CFG/tls/fullchain.pem" "$CFG/tls/key.pem"; then
        subject=$(openssl x509 -in "$CFG/tls/fullchain.pem" -noout -subject -nameopt RFC2253)
        issuer=$(openssl x509 -in "$CFG/tls/fullchain.pem" -noout -issuer -nameopt RFC2253)
        if [[ ${subject#subject=} == "${issuer#issuer=}" ]]; then
          cp "$CFG/tls/fullchain.pem" "$temporary/fullchain.pem"
          cp "$CFG/tls/key.pem" "$temporary/key.pem"
        fi
      fi
      if [[ ! -s $temporary/fullchain.pem ]]; then
        say 'Generating a self-signed HTTPS certificate...'
        san="DNS:$HOST"; [[ ! $HOST =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || san="IP:$HOST"
        if ! openssl req -x509 -newkey rsa:2048 -noenc -sha256 -days 365 \
          -keyout "$temporary/key.pem" -out "$temporary/fullchain.pem" -subj "/CN=$HOST" \
          -addext "subjectAltName=$san" -addext 'basicConstraints=critical,CA:FALSE' \
          -addext 'keyUsage=critical,digitalSignature,keyEncipherment' -addext 'extendedKeyUsage=serverAuth' \
          >/dev/null 2>"$temporary/openssl.log"; then
          cat "$temporary/openssl.log" >&2; die 'The self-signed certificate could not be generated.'
        fi
      else say 'Reusing the existing certificate.'; fi
    fi
    tls_pair_valid "$temporary/fullchain.pem" "$temporary/key.pem" || die 'The certificate/key pair is invalid, expired, mismatched, encrypted, or does not cover this host.'
    install -m 600 "$temporary/key.pem" "$CFG/tls/key.pem.new"
    install -m 600 "$temporary/fullchain.pem" "$CFG/tls/fullchain.pem.new"
    mv "$CFG/tls/key.pem.new" "$CFG/tls/key.pem"
    mv "$CFG/tls/fullchain.pem.new" "$CFG/tls/fullchain.pem"
    sync -f "$CFG/tls/fullchain.pem"
    rm -rf -- "$temporary"
  fi
  TLS_PENDING=n; save_state
}
setup_acme_renewal() {
  cat > /etc/systemd/system/kaigenweb-acme.service <<EOF
[Unit]
Description=Renew Kaigen Web certificate
After=network-online.target kaigenweb-nginx.service
[Service]
Type=oneshot
ExecStart=/bin/bash $APP/acme.sh --cron --home $APP --config-home $STATE/acme
EOF
  cat > /etc/systemd/system/kaigenweb-acme.timer <<'EOF'
[Unit]
Description=Check Kaigen Web certificate hourly
[Timer]
OnCalendar=hourly
RandomizedDelaySec=300
Persistent=true
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now kaigenweb-acme.timer
}

setup_tor() {
  [[ $USE_TOR == y ]] || return 0
  mkdir -p "$STATE/tor"
  chown kaigenweb:kaigenweb "$STATE/tor"
  chmod 700 "$STATE/tor"
  cat > "$CFG/torrc" <<EOF
DataDirectory $STATE/tor/data
SocksPort 127.0.0.1:19050
HiddenServiceDir $STATE/tor/onion
HiddenServicePort 80 127.0.0.1:8089
Log notice stdout
EOF
  chown root:kaigenweb "$CFG/torrc"
  chmod 640 "$CFG/torrc"
  cat > /etc/systemd/system/kaigenweb-tor.service <<EOF
[Unit]
Description=Kaigen Web onion access
After=network-online.target
[Service]
User=kaigenweb
ExecStart=/usr/bin/tor -f $CFG/torrc
Restart=on-failure
NoNewPrivileges=true
ProtectHome=true
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now kaigenweb-tor.service
  for ((i=0;i<120;i++)); do
    if [[ -f "$STATE/tor/onion/hostname" ]]; then
      ONION=$(cat "$STATE/tor/onion/hostname"); return
    fi
    sleep 1
  done
  die 'Tor did not create an onion address.'
}

personal_entry() {
  [[ $MODE == personal ]] || return 0
  cat > "$APP/current/ui/personal-entry.js" <<'EOF'
const match = /^\/space\/([A-Za-z0-9_-]{40,80})\/?$/.exec(location.pathname);
if (match && !location.hash) history.replaceState(null, '', location.pathname + '#k=' + match[1]);
EOF
  sed 's|</head>|<script src="/personal-entry.js"></script></head>|' "$APP/current/ui/index.html" > "$APP/current/ui/personal.html"
  chmod 644 "$APP/current/ui/personal-entry.js" "$APP/current/ui/personal.html"
}

verify_install() {
  local service path=/ tls_args=() services=(kaigenweb.service kaigenweb-nginx.service run-kaigenweb.mount)
  if [[ $TLS_MODE == auto ]]; then services+=(kaigenweb-acme.timer)
  else tls_args=(--cacert "$CFG/tls/fullchain.pem"); fi
  for service in "${services[@]}"; do
    systemctl is-enabled --quiet "$service" && systemctl is-active --quiet "$service" || die '%s is not enabled and active.' "$service"
  done
  wait_backend 8787
  [[ $MODE != personal ]] || path="/space/$PERSONAL"
  curl "${tls_args[@]}" -fsS --max-time 30 "https://$HOST$path" -o /dev/null
  curl "${tls_args[@]}" -fsSI --max-time 30 "https://$HOST$path" | grep -qi '^Content-Type: text/html' || die 'The Web entry is not served as HTML.'
  curl "${tls_args[@]}" -fsS --max-time 30 "https://$HOST/api/v1/build-identity" | jq -e --arg build "$BUILD" '.buildId==$build' >/dev/null
  curl "${tls_args[@]}" -fsS --max-time 30 -H "Origin: https://$HOST" -H "X-Kaigen-Client-Build: $BUILD" \
    --data '{}' "https://$HOST/api/v1/initializer/challenge" | jq -e '.difficulty==18' >/dev/null
  if [[ $TLS_MODE == auto ]]; then systemctl start kaigenweb-acme.service
  elif systemctl is-active --quiet kaigenweb-acme.timer || systemctl is-active --quiet kaigenweb-acme.service; then
    die 'ACME renewal is still active.'
  fi
  if [[ $MODE == personal ]]; then
    [[ $(curl "${tls_args[@]}" -s -o /dev/null -w '%{http_code}' "https://$HOST/") == 404 ]] || die 'Personal registration page is exposed.'
    [[ $(curl "${tls_args[@]}" -s -o /dev/null -w '%{http_code}' -H "Origin: https://$HOST" --data '{}' "https://$HOST/api/v1/workspaces") == 403 ]] || die 'Personal registration API is exposed.'
  fi
  if [[ $USE_TOR == y ]]; then
    systemctl is-enabled --quiet kaigenweb-tor.service && systemctl is-active --quiet kaigenweb-tor.service
    say 'Waiting for Tor and checking the onion URL...'
    local ok=n
    for ((i=0;i<30;i++)); do
      if curl -fsS --max-time 20 --socks5-hostname 127.0.0.1:19050 "http://$ONION$path" -o /dev/null; then ok=y; break; fi
      sleep 5
    done
    [[ $ok == y ]] || die 'The onion URL is not reachable through Tor.'
    curl -fsS --max-time 60 --socks5-hostname 127.0.0.1:19050 \
      -H "Origin: http://$ONION" -H "X-Kaigen-Client-Build: $BUILD" \
      --data '{}' "http://$ONION/api/v1/initializer/challenge" | jq -e '.difficulty==18' >/dev/null
    [[ $(curl -s --max-time 30 --socks5-hostname 127.0.0.1:19050 -o /dev/null -w '%{http_code}' \
      -H 'Origin: https://example.invalid' -H "X-Kaigen-Client-Build: $BUILD" --data '{}' \
      "http://$ONION/api/v1/initializer/challenge") == 403 ]] || die 'The onion service accepted an unrelated Origin.'
  fi
  say "INSTALL_CHECK_PASS version=$VERSION mode=$MODE tor=$USE_TOR tls=$TLS_MODE services=enabled-and-active"
}

uninstall() {
  local list user
  if [[ -f $TMP/packages.pending ]]; then
    wait_package_manager
    if ! dpkg --configure -a; then apt-get -y -o DPkg::Lock::Timeout=120 --fix-broken install; dpkg --configure -a; fi
    record_added_packages
    restore_auto_flags
  fi
  list=$(cat "$STATE/packages.added" 2>/dev/null || true)
  if [[ -n "$list" ]]; then
    while read -r user; do [[ $user =~ ^[a-z0-9][a-z0-9+.-]*(:amd64)?$ ]] || die 'Invalid package manifest.'; done <<< "$list"
    readarray -t added <<< "$list"
    apt-get -s purge "${added[@]}" > "$TMP/purge-plan"
    sed 's/:amd64$//' <<< "$list" | sort -u > "$TMP/owned-packages"
    while read -r user; do
      grep -qxF "${user%:amd64}" "$TMP/owned-packages" || die 'Removal would also remove unrelated package %s.' "$user"
    done < <(awk '$1=="Remv" || $1=="Purg" {print $2}' "$TMP/purge-plan")
  fi
  say 'Removing Kaigen Web, all its workspaces, and components added by this installer...'
  systemctl disable --now kaigenweb.service kaigenweb-nginx.service kaigenweb-tor.service kaigenweb-acme.timer 2>/dev/null || true
  systemctl stop kaigenweb-acme.service kaigenweb-check.service 2>/dev/null || true
  systemctl disable --now run-kaigenweb.mount 2>/dev/null || true
  rm -f /etc/systemd/system/kaigenweb{,-nginx,-tor,-acme}.service /etc/systemd/system/kaigenweb-acme.timer
  rm -f /etc/systemd/system/run-kaigenweb.mount
  systemctl daemon-reload
  systemctl reset-failed kaigenweb.service kaigenweb-nginx.service kaigenweb-tor.service kaigenweb-acme.service kaigenweb-check.service 2>/dev/null || true
  [[ -z "$list" ]] || apt-get purge -y "${added[@]}"
  # A new Tor package creates its default data/log directories even when we
  # use a private instance. Preserve directories present before installation.
  if grep -qx tor "$STATE/packages.added" 2>/dev/null; then
    local directory
    for directory in /var/lib/tor /var/log/tor; do
      if [[ -f "$STATE/directories.before" ]]; then
        grep -qxF "$directory" "$STATE/directories.before" || rm -rf -- "$directory"
      elif ! grep -qx debian-tor "$STATE/users.before" && [[ -d $directory && $(stat -c %U "$directory") == debian-tor ]]; then
        rm -rf -- "$directory"
      fi
    done
  fi
  if [[ -f "$STATE/users.before" ]]; then
    while IFS=: read -r user _; do
      [[ $user != debian-tor ]] || grep -qx tor "$STATE/packages.added" 2>/dev/null || continue
      if ! grep -qxF "$user" "$STATE/users.before" && [[ $user == kaigenweb || $user == debian-tor ]]; then userdel "$user"; fi
    done < /etc/passwd
  fi
  [[ ! -f "$STATE/groups.before" ]] || while IFS=: read -r user _; do
    [[ $user != debian-tor ]] || grep -qx tor "$STATE/packages.added" 2>/dev/null || continue
    if ! grep -qxF "$user" "$STATE/groups.before" && [[ $user == kaigenweb || $user == debian-tor ]]; then groupdel "$user" 2>/dev/null || true; fi
  done < /etc/group
  rm -rf -- "$APP" "$CFG" /run/kaigenweb /run/kaigenweb-nginx.pid
  local package
  for package in ${list:-}; do
    [[ $(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null || true) != installed ]] || die 'Package %s remains installed.' "$package"
  done
  rm -rf -- "$STATE"
  [[ ! -e "$APP" && ! -e "$CFG" && ! -e "$STATE" ]] || die 'Managed paths remain after removal.'
  say 'UNINSTALL_PASS dataRemoved=true'
}

record_added_packages() {
  [[ -f $TMP/packages.operation.before && -f $TMP/packages.operation.plan ]] || return 0
  local package status
  while read -r package; do
    [[ $package =~ ^[a-z0-9][a-z0-9+.-]*(:amd64)?$ ]] || die 'Invalid package manifest.'
    if ! grep -qxF "$package" "$TMP/packages.operation.before"; then
      status=$(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null || true)
      case $status in installed|unpacked|half-installed|half-configured|triggers-awaited|triggers-pending)
        printf '%s\n' "$package" >> "$STATE/packages.added";; esac
    fi
  done < "$TMP/packages.operation.plan"
  sort -u -o "$STATE/packages.added" "$STATE/packages.added"
  sync -f "$STATE/packages.added"
}
restore_auto_flags() {
  [[ -f $TMP/auto.before-op ]] || return 0
  local package
  for package in ca-certificates curl jq nginx openssl iproute2 xz-utils libcap2-bin tor; do
    if grep -qxF "$package" "$TMP/auto.before-op" &&
       [[ $(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null || true) == installed ]]; then
      apt-mark auto "$package" >/dev/null
    fi
  done
}
wait_package_manager() {
  local attempt
  for ((attempt=0;attempt<120;attempt++)); do
    if ! lslocks --raw --noheadings --notruncate --output PATH | grep -Eq '^/var/lib/(dpkg/lock(-frontend)?|apt/lists/lock)$'; then return; fi
    say 'Waiting for the package manager...'; sleep 3
  done
  die 'The package manager is busy. Retry later.'
}
install_packages() {
  local deps=(ca-certificates curl jq nginx openssl iproute2 xz-utils libcap2-bin)
  [[ $USE_TOR != y ]] || deps+=(tor)
  wait_package_manager
  record_added_packages
  if ! dpkg --configure -a; then
    apt-get -y -o DPkg::Lock::Timeout=120 --fix-broken install
    dpkg --configure -a
  fi
  apt-get update -qq
  if [[ ! -f $TMP/packages.pending ]]; then
    packages > "$TMP/packages.operation.before"
    apt-mark showauto > "$TMP/auto.before-op"
    apt-get -s --no-install-recommends install "${deps[@]}" > "$TMP/package-plan"
    awk '$1=="Inst" {sub(/:amd64$/,"",$2); print $2}' "$TMP/package-plan" | sort -u > "$TMP/packages.operation.plan"
    touch "$TMP/packages.pending"; sync -f "$TMP/packages.pending"
  fi
  local result=0
  apt-get install -y -qq -o DPkg::Lock::Timeout=120 -o Dpkg::Use-Pty=0 --no-install-recommends "${deps[@]}" || result=$?
  record_added_packages
  restore_auto_flags
  ((result==0)) || return "$result"
  rm -f "$TMP/packages.pending"
  if ! grep -qx nginx "$STATE/packages.before"; then systemctl disable --now nginx.service; fi
  if [[ $USE_TOR == y ]] && ! grep -qx tor "$STATE/packages.before"; then
    systemctl disable --now tor.service tor@default.service 2>/dev/null || true
  fi
}
download_release() {
  local metadata asset digest target
  if [[ ! -s $TMP/release.json ]]; then
    fetch -o "$TMP/release.json.part" "https://api.github.com/repos/$REPO/releases/latest"
    jq -e '.tag_name and .assets' "$TMP/release.json.part" >/dev/null
    mv "$TMP/release.json.part" "$TMP/release.json"; sync -f "$TMP/release.json"
  fi
  metadata=$(cat "$TMP/release.json")
  VERSION=$(jq -er '.tag_name' <<< "$metadata")
  [[ $VERSION =~ ^v[0-9][A-Za-z0-9._-]*$ ]] || die 'Invalid GitHub release tag.'
  asset=$(jq -cer '[.assets[] | select(.name | test("^Kaigen-Web-Debian13-Nginx-[A-Za-z0-9._-]+\\.tar\\.gz$"))] | if length==1 then .[0] else error("Web bundle is missing or ambiguous") end' <<< "$metadata")
  digest=$(jq -er '.digest | select(test("^sha256:[a-f0-9]{64}$"))' <<< "$asset")
  say 'Downloading official Kaigen Web %s...' "$VERSION"
  if [[ ! -f $TMP/bundle.tar.gz ]] || ! printf '%s  %s\n' "${digest#sha256:}" "$TMP/bundle.tar.gz" | sha256sum -c - >/dev/null 2>&1; then
    fetch -o "$TMP/bundle.tar.gz.part" "https://github.com/$REPO/releases/download/$VERSION/$(jq -r .name <<< "$asset")"
    printf '%s  %s\n' "${digest#sha256:}" "$TMP/bundle.tar.gz.part" | sha256sum -c -
    mv "$TMP/bundle.tar.gz.part" "$TMP/bundle.tar.gz"; sync -f "$TMP/bundle.tar.gz"
  fi
  rm -rf -- "$TMP/bundle"
  mkdir "$TMP/bundle"
  tar -tzf "$TMP/bundle.tar.gz" | awk '/(^\/|(^|\/)\.\.(\/|$))/{bad=1} END{exit bad}' || die 'Unsafe archive paths.'
  tar -xzf "$TMP/bundle.tar.gz" -C "$TMP/bundle" --no-same-owner
  (cd "$TMP/bundle" && sha256sum -c manifest.sha256 >/dev/null)
  BUILD=$(tr -d '\r\n' < "$TMP/bundle/release-id")
  [[ $BUILD =~ ^[A-Za-z0-9][A-Za-z0-9._-]{11,79}$ ]] || die 'Invalid Web build identity.'
  [[ $(cat "$TMP/bundle/payload/ui/kaigen-build-id") == "$BUILD" ]] || die 'UI identity mismatch.'
  target="$APP/releases/$BUILD"
  if [[ -f $target/.bundle-sha256 ]] && [[ $(cat "$target/.bundle-sha256") == "${digest#sha256:}" ]]; then
    [[ -x $target/bin/kaigen-webd ]] || die 'Installed release validation failed.'
  else
    [[ ! -e $target ]] || die 'This release directory already exists; refusing to overwrite it.'
    rm -rf -- "$target.staging"
    mkdir -p "$target.staging"
    cp -a "$TMP/bundle/payload/." "$target.staging/"
    (cd "$target.staging" && sed -n 's|^\([a-f0-9]\{64\}\)  payload/|\1  |p' "$TMP/bundle/manifest.sha256" | sha256sum -c - >/dev/null)
    ln -sfn libtoxcore.so.2.24.0 "$target.staging/lib/Kaigen/libtoxcore.so.2"
    chmod -R a+rX "$target.staging"
    chmod 755 "$target.staging/bin/kaigen-webd" "$target.staging/TorExpertBundle/tor/tor"
    printf '%s\n' "${digest#sha256:}" > "$target.staging/.bundle-sha256"
    mv "$target.staging" "$target"; sync -f "$target"
  fi
  if [[ $ACTION == install ]]; then ln -sfn "$target" "$APP/current"; fi
  save_state
}
prepare_backend() {
  if ! id kaigenweb >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$STATE" --shell /usr/sbin/nologin kaigenweb
  else
    [[ $(getent passwd kaigenweb | cut -d: -f6) == "$STATE" ]] || die 'The kaigenweb account already exists.'
  fi
  mkdir -p "$STATE/disk"
  chown kaigenweb:kaigenweb "$STATE/disk"; chmod 700 "$STATE/disk"
  if [[ ! -e $STATE/.disk.kaigen-webd.lock ]]; then
    install -o kaigenweb -g kaigenweb -m 600 /dev/null "$STATE/.disk.kaigen-webd.lock"
  fi
  write_backend
}
prepare_personal() {
  [[ $MODE == personal ]] || return 0
  local password identifier API_PORT=8787 API_EXTRA=()
  if [[ ! -f $STATE/personal.password ]]; then
    openssl rand -hex 18 > "$STATE/personal.password"
    chmod 600 "$STATE/personal.password"; sync -f "$STATE/personal.password"
  fi
  secure_file "$STATE/personal.password"; password=$(cat "$STATE/personal.password")
  [[ $password =~ ^[a-f0-9]{36}$ ]] || die 'Invalid installer state.'
  if [[ -z $PERSONAL && -f $STATE/personal.identifier ]]; then PERSONAL=$(cat "$STATE/personal.identifier"); fi
  if [[ -n $PERSONAL ]]; then
    [[ $PERSONAL =~ ^[A-Za-z0-9_-]{40,80}$ ]] || die 'Invalid installer state.'
  else
    [[ $PUBLIC_READY == n ]] || die 'Personal workspace recovery requires manual inspection.'
    # No public routes exist yet. Only this fresh installation owns these roots.
    # Reset an uncertain create result instead of creating an inaccessible duplicate.
    systemctl stop kaigenweb.service 2>/dev/null || true
    rm -rf -- "$STATE/disk" /run/kaigenweb/ram /run/kaigenweb/active
    install -d -o kaigenweb -g kaigenweb -m 700 "$STATE/disk"
    sed -i 's/PROOF_DIFFICULTY=18/PROOF_DIFFICULTY=12/' "$CFG/backend.env"
    systemctl daemon-reload; systemctl start kaigenweb.service; wait_backend 8787
    identifier=$(create_workspace "$password")
    [[ $identifier =~ ^[A-Za-z0-9_-]{40,80}$ ]] || die 'Invalid workspace identifier.'
    printf '%s\n' "$identifier" > "$STATE/personal.identifier.new"
    sync -f "$STATE/personal.identifier.new"
    mv "$STATE/personal.identifier.new" "$STATE/personal.identifier"
    PERSONAL=$identifier; save_state
  fi
  systemctl stop kaigenweb.service
  sed -i 's/PROOF_DIFFICULTY=12/PROOF_DIFFICULTY=18/' "$CFG/backend.env"
  personal_entry
}
start_backend() {
  systemctl daemon-reload
  systemctl enable --now kaigenweb.service
  wait_backend 8787
}

publish_routes() {
  start_backend
  setup_tor
  write_nginx yes
  systemctl reload kaigenweb-nginx.service
  PUBLIC_READY=y; save_state
}
install_pipeline() {
  stage 1 'Packages' install_packages
  stage 2 'Official Web release' download_release
  stage 3 'Backend and memory storage' prepare_backend
  stage 4 'Workspace creation and deletion' check_workspace
  stage 5 'Personal workspace' prepare_personal
  stage 6 'Web server' setup_nginx_service
  stage 7 'HTTPS certificate' certificate
  stage 8 'Public routes and Tor' publish_routes
  stage 9 'Final service and API checks' verify_install
  COMPLETE=y STATUS=complete; save_state
  log_action 'Installation completed.'
}
update() {
  local old_version=$VERSION old_build=$BUILD latest
  if [[ -n $OLD_BUILD && -f $STATE/nginx.previous ]]; then
    systemctl stop kaigenweb.service
    ln -sfn "$APP/releases/$OLD_BUILD" "$APP/current"
    cp "$STATE/nginx.previous" "$CFG/nginx.conf"
    systemctl start kaigenweb.service; systemctl reload kaigenweb-nginx.service
    if [[ -n $NEW_BUILD && $NEW_BUILD != "$OLD_BUILD" ]]; then rm -rf -- "$APP/releases/$NEW_BUILD"; fi
    BUILD=$OLD_BUILD VERSION=$OLD_VERSION OLD_BUILD='' OLD_VERSION='' NEW_BUILD=''
    save_state
  fi
  old_version=$VERSION old_build=$BUILD
  install_packages
  latest=$(fetch "https://api.github.com/repos/$REPO/releases/latest" | jq -er .tag_name)
  if [[ $latest == "$VERSION" ]]; then
    say 'Already up to date: %s' "$VERSION"; verify_install
    COMPLETE=y STATUS=complete; save_state; return
  fi
  rm -f "$TMP/release.json" "$TMP/bundle.tar.gz"
  OLD_BUILD=$old_build OLD_VERSION=$old_version
  cp "$CFG/nginx.conf" "$STATE/nginx.previous"; save_state
  download_release
  NEW_BUILD=$BUILD; save_state
  UPDATE_PENDING=y
  systemctl stop kaigenweb.service
  ln -sfn "$APP/releases/$BUILD" "$APP/current"
  personal_entry
  systemctl start kaigenweb.service; wait_backend 8787
  write_nginx yes; systemctl reload kaigenweb-nginx.service
  check_workspace; verify_install
  UPDATE_PENDING=n OLD_BUILD='' OLD_VERSION='' NEW_BUILD='' COMPLETE=y STATUS=complete
  save_state; rm -f "$STATE/nginx.previous"
  say "UPDATE_PASS previous=$old_version current=$VERSION"
}

choose_tls() {
  local default=${1:-1} choice answer cert_default key_default
  while :; do
    say "1) Let's Encrypt  2) Existing certificate  3) Self-signed certificate  4) Stop"
    ask 'Choose HTTPS certificate [1/2/3/4] [%s]: ' choice "$default"
    case ${choice:-$default} in
      1) TLS_MODE=auto TLS_PENDING=n; return;;
      2)
        cert_default=$TLS_CERT_PATH key_default=$TLS_KEY_PATH
        [[ -n $cert_default || ! -f /etc/letsencrypt/live/$HOST/fullchain.pem ]] || cert_default="/etc/letsencrypt/live/$HOST/fullchain.pem"
        [[ -n $key_default || ! -f /etc/letsencrypt/live/$HOST/privkey.pem ]] || key_default="/etc/letsencrypt/live/$HOST/privkey.pem"
        ask 'Full-chain PEM path [%s]: ' TLS_CERT_PATH "$cert_default"
        TLS_CERT_PATH=${TLS_CERT_PATH:-$cert_default}
        ask 'Unencrypted private-key PEM path [%s]: ' TLS_KEY_PATH "$key_default"
        TLS_KEY_PATH=${TLS_KEY_PATH:-$key_default}
        if [[ $TLS_CERT_PATH == /* && $TLS_KEY_PATH == /* && -f $TLS_CERT_PATH && -f $TLS_KEY_PATH &&
              $TLS_CERT_PATH != *$'\r'* && $TLS_KEY_PATH != *$'\r'* ]]; then
          TLS_MODE=existing TLS_PENDING=n; return
        fi
        say 'Both PEM files must exist at absolute paths.';;
      3)
        say 'A self-signed certificate encrypts traffic, but browsers will show a trust warning.'
        ask 'Generate and use a self-signed certificate? [y/N]: ' answer
        case $answer in y|Y|yes|Yes|YES|д|Д|да|Да|ДА) TLS_MODE=selfsigned TLS_PENDING=n; return;; esac
        say 'Self-signed certificate was not selected.';;
      4) say 'Run this script again when you want to continue.'; exit 1;;
      *) say 'Choose 1, 2, 3 or 4.';;
    esac
  done
}
collect_settings() {
  say 'Welcome to Kaigen Web. This installs the latest official Web release, its dependencies, Nginx and HTTPS.'
  say '1) Personal: one private workspace. 2) Service: users can create workspaces.'
  local choice value
  ask 'Choose mode [1/2]: ' choice
  case $choice in 1) MODE=personal;; 2) MODE=service;; *) die 'Choose 1 or 2.';; esac
  DISK_MIB=256 RAM_MIB=128
  if [[ $MODE == service ]]; then
    ask 'Disk limit per workspace, MiB [%s]: ' value 256
    DISK_MIB=${value:-256}
    ask 'RAM limit per workspace, MiB [%s]: ' value 128
    RAM_MIB=${value:-128}
    [[ $DISK_MIB =~ ^[1-9][0-9]{0,6}$ && $RAM_MIB =~ ^[1-9][0-9]{0,6}$ ]] || die 'Limits must be positive whole MiB values.'
  fi
  ask 'Public domain or IPv4 address (no scheme or path): ' HOST
  HOST=${HOST,,}
  [[ $HOST =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ && $HOST != *..* ]] || die 'Invalid hostname or IPv4 address.'
  ask 'Enable Tor onion access? [y/N]: ' USE_TOR
  case $USE_TOR in y|Y|yes|Yes|YES|д|Д|да|Да|ДА) USE_TOR=y;; *) USE_TOR=n;; esac
  TLS_MODE=auto TLS_PENDING=n TLS_CERT_PATH='' TLS_KEY_PATH=''
  choose_tls
}
capture_baseline() {
  [[ ! -f $STATE/baseline.ready ]] || return 0
  packages > "$STATE/packages.before.new"
  cut -d: -f1 /etc/passwd > "$STATE/users.before.new"
  cut -d: -f1 /etc/group > "$STATE/groups.before.new"
  : > "$STATE/directories.before.new"
  local directory
  for directory in /var/lib/tor /var/log/tor; do
    [[ ! -e $directory ]] || printf '%s\n' "$directory" >> "$STATE/directories.before.new"
  done
  for directory in packages users groups directories; do mv "$STATE/$directory.before.new" "$STATE/$directory.before"; done
  : > "$STATE/packages.added"
  touch "$STATE/baseline.ready"; sync -f "$STATE/baseline.ready"
}
snapshot_worker() {
  cp -- "$SELF" "$STATE/installer.new"
  chmod 700 "$STATE/installer.new"
  CODE_HASH=$(sha256sum < "$STATE/installer.new"); CODE_HASH=${CODE_HASH%% *}
  mv "$STATE/installer.new" "$STATE/installer.sh"
  sync -f "$STATE/installer.sh"; save_state
}
initialize_installation() {
  [[ ! -e $APP && ! -e $CFG && ! -e $STATE ]] || die 'Unmanaged Kaigen paths already exist.'
  if command -v ss >/dev/null && ss -ltnH '( sport = :80 or sport = :443 or sport = :8787 or sport = :8089 or sport = :19050 )' | read -r _; then
    die 'A required port is already in use. No existing service was changed.'
  fi
  id kaigenweb >/dev/null 2>&1 && die 'The kaigenweb account already exists.'
  STAGE=0 ACTION=install STATUS=idle COMPLETE=n PUBLIC_READY=n VERSION='' BUILD='' PERSONAL='' ONION=''
  CODE_HASH=$(sha256sum < "$SELF"); CODE_HASH=${CODE_HASH%% *}
  mkdir -m 755 "$STATE"
  printf 'Kaigen Web installer state v2\n' > "$STATE/owner"
  save_state
  capture_baseline
  mkdir -p "$CFG" "$APP/releases" "$STATE/cache"
  chmod 755 "$CFG" "$APP" "$APP/releases"; chmod 700 "$STATE/cache"
  : > "$STATE/install.log"; chmod 600 "$STATE/install.log"
  snapshot_worker
}
worker_is_running() { systemctl is-active --quiet "$UNIT"; }
assert_worker() {
  [[ $(systemctl show -p ExecStart --value "$UNIT") == *"$STATE/installer.sh --worker"* ]] || die 'An unrelated installer service exists.'
}
show_result() {
  local path=/
  [[ $MODE != personal ]] || path="/space/$PERSONAL"
  say 'Open: %s' "https://$HOST$path${PERSONAL:+#k=$PERSONAL}"
  [[ $USE_TOR != y ]] || say 'Tor: %s' "http://$ONION$path${PERSONAL:+#k=$PERSONAL}"
  if [[ $MODE == personal && -f $STATE/personal.password ]]; then
    secure_file "$STATE/personal.password"
    say 'Workspace password (save it now): %s' "$(cat "$STATE/personal.password")"
  fi
  say 'TLS certificate type: %s' "$TLS_MODE"
  say 'TLS certificate expires: %s' "$(openssl x509 -in "$CFG/tls/fullchain.pem" -noout -enddate | cut -d= -f2-)"
  say 'TLS SHA-256 fingerprint: %s' "$(openssl x509 -in "$CFG/tls/fullchain.pem" -noout -fingerprint -sha256 | cut -d= -f2-)"
  if [[ $TLS_MODE != auto ]]; then
    [[ $TLS_MODE != selfsigned ]] || say 'A self-signed certificate encrypts traffic, but browsers will show a trust warning.'
    [[ $TLS_MODE != existing ]] || say 'Browser trust for an existing certificate depends on its issuer.'
    say 'Built-in ACME renewal is disabled for this certificate.'
  fi
}
follow_worker() {
  local launcher=${1:-} frame=0 frames='|/-\' result=0 chosen=$UI_LANG
  tail --quiet --follow=name --retry --sleep-interval=0.25 -n 25 "$STATE/install.log" 8>&- 2>/dev/null &
  TAIL_PID=$!
  while :; do
    if [[ -n $launcher ]]; then kill -0 "$launcher" 2>/dev/null || break
    else worker_is_running || break; fi
    printf '\r[%s] %s' "${frames:frame%4:1}" "$(text 'Working; you may reconnect without restarting the installation.')"
    ((frame+=1)); sleep 1
  done
  if [[ -n $launcher ]]; then wait "$launcher" || result=$?; fi
  kill "$TAIL_PID" 2>/dev/null || true; wait "$TAIL_PID" 2>/dev/null || true; TAIL_PID=''
  printf '\r%72s\r' ''
  if [[ -f $STATE/settings ]]; then
    load_state; UI_LANG=$chosen
    if [[ $TLS_PENDING == y && $ACTION == install && $COMPLETE != y ]]; then
      say 'HTTPS setup did not finish. Choose another certificate option or stop with progress saved.'
      choose_tls 4
      dispatch_worker; return
    fi
  fi
  if ((result != 0)); then
    say 'Operation failed. Log: %s' "$STATE/install.log" >&2; return "$result"
  fi
  if [[ ! -e $STATE ]]; then say 'UNINSTALL_PASS dataRemoved=true'; return; fi
  load_state; UI_LANG=$chosen
  [[ $COMPLETE == y && $STATUS == complete ]] || die 'Operation stopped. Run the installer again to continue or remove its data.'
  say 'Installation completed.'
  show_result
}
dispatch_worker() {
  [[ ! -L $STATE/install.log ]] || die 'Unsafe installer state: %s' "$STATE/install.log"
  touch "$STATE/install.log"; chmod 600 "$STATE/install.log"
  secure_file "$STATE/install.log"
  snapshot_worker
  STATUS=running; save_state
  systemctl reset-failed "$UNIT" 2>/dev/null || true
  say 'Action log: %s' "$STATE/install.log"
  systemd-run --quiet --wait --collect --unit=kaigenweb-installer --service-type=exec \
    --expand-environment=no --property=StandardInput=null \
    --property="StandardOutput=append:$STATE/install.log" --property=StandardError=inherit \
    --property=TimeoutStopSec=90 /bin/bash --noprofile --norc -p "$STATE/installer.sh" --worker 8>&- &
  WAIT_PID=$!
  follow_worker "$WAIT_PID"
  WAIT_PID=''
}
confirm_removal() {
  local answer
  ask 'This permanently deletes ALL Kaigen workspaces. Type DELETE: ' answer
  [[ $answer == DELETE || $answer == УДАЛИТЬ ]] || die 'Removal cancelled.'
}
worker_main() {
  IS_WORKER=y
  check_system
  load_state
  secure_file "$STATE/installer.sh"
  local actual; actual=$(sha256sum < "$STATE/installer.sh"); actual=${actual%% *}
  [[ $actual == "$CODE_HASH" && $SELF == "$STATE/installer.sh" ]] || die 'Installer snapshot validation failed.'
  exec 9>/run/kaigenweb-install.lock
  flock -n 9 || die 'Another Kaigen Web installer is running.'
  WORKER_LOCKED=y
  TMP="$STATE/cache"; mkdir -p "$TMP"; chmod 700 "$TMP"
  log_action 'Worker started: %s' "$ACTION"
  case $ACTION in
    install) install_pipeline;;
    update) update;;
    remove) uninstall;;
  esac
}
main() {
  if [[ ${1:-} == --worker ]]; then [[ $EUID == 0 ]] || exit 1; worker_main; return; fi
  local inspect=n choice='' selected_language
  if [[ ${1:-} == --language ]]; then
    [[ ${2:-} =~ ^(ru|en)$ ]] || exit 1
    UI_LANG=$2; shift 2
  else select_language; fi
  if [[ ${1:-} == --inspect ]]; then inspect=y; shift; fi
  (($#==0)) || die 'Unknown option.'
  FRONT_INSPECT=$inspect
  elevate
  check_system
  [[ $inspect != y ]] || { inventory; return; }
  exec 8>/run/kaigenweb-ui.lock
  flock -n 8 || die 'Another installer control session is open.'
  UI_LOCKED=y
  selected_language=$UI_LANG
  # No component can be installed before the first settings checkpoint exists.
  # Recover even an interruption between creating its directory and saving it.
  if [[ -d $STATE && ! -e $STATE/settings && ! -e $APP && ! -e $CFG ]]; then
    secure_dir "$STATE"
    if find "$STATE" -mindepth 1 -maxdepth 1 ! -name owner ! -name settings.new -print -quit | read -r _; then
      die 'Unmanaged Kaigen paths already exist.'
    fi
    if [[ -e $STATE/owner ]]; then
      secure_file "$STATE/owner"
      [[ ! -s $STATE/owner || $(cat "$STATE/owner") == 'Kaigen Web installer state v2' ]] || die 'Invalid installer state.'
    fi
    [[ ! -e $STATE/settings.new ]] || secure_file "$STATE/settings.new"
    say 'An unfinished installation was found.'
    ask '1) Continue installation  2) Remove all unfinished data: ' choice
    case $choice in 1) ;; 2) confirm_removal;; *) die 'Choose 1 or 2.';; esac
    rm -f -- "$STATE/owner" "$STATE/settings.new"; rmdir "$STATE"
    if [[ $choice == 2 ]]; then say 'UNINSTALL_PASS dataRemoved=true'; return; fi
  fi
  if [[ -f $STATE/settings ]]; then
    load_state; UI_LANG=$selected_language
    if [[ $COMPLETE != y ]]; then
      say 'An unfinished installation was found.'
      ask '1) Continue installation  2) Remove all unfinished data: ' choice
      case $choice in
        1)
          if worker_is_running; then assert_worker; follow_worker; return; fi
          if [[ $TLS_PENDING == y && $ACTION == install ]]; then
            say 'HTTPS setup did not finish. Choose another certificate option or stop with progress saved.'
            choose_tls 4
          fi
          capture_baseline
          mkdir -p "$CFG" "$APP/releases" "$STATE/cache"
          chmod 755 "$CFG" "$APP" "$APP/releases"; chmod 700 "$STATE/cache"
          dispatch_worker; return;;
        2)
          confirm_removal
          if worker_is_running; then assert_worker; systemctl stop "$UNIT"; fi
          ACTION=remove STAGE=0 COMPLETE=n; dispatch_worker; return;;
        *) die 'Choose 1 or 2.';;
      esac
    fi
    say 'Kaigen Web is already installed.'
    say '1) Update Kaigen and packages  2) Uninstall (erase all data)  3) Reinstall (erase all data)  4) Exit'
    ask 'Choose [1/2/3/4]: ' choice
    case $choice in
      1) ACTION=update STAGE=0 COMPLETE=n; dispatch_worker;;
      2|3)
        confirm_removal
        ACTION=remove STAGE=0 COMPLETE=n; dispatch_worker
        if [[ $choice == 3 ]]; then
          VERSION='' BUILD='' PERSONAL='' ONION='' COMPLETE=n
          collect_settings; initialize_installation; dispatch_worker
        fi;;
      4) return;;
      *) die 'Choose 1, 2, 3 or 4.';;
    esac
  else
    collect_settings; initialize_installation; dispatch_worker
  fi
}
main "$@"
