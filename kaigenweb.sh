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
DISK_MIB=256 RAM_MIB=128 LEASE_HOURS=72 STAGE=0 ACTION=install STATUS=idle CODE_HASH='' SCHEMA=2
OLD_BUILD='' OLD_VERSION='' NEW_BUILD='' PUBLIC_READY=n
AUTO_UPDATES=n AUTO_CHOICE='' SCHEDULED=n ACTIVE_SLOT=a BACKEND_STYLE=single OLD_SLOT='' OLD_STYLE='' RELEASE_DIGEST=''
TLS_MODE=auto TLS_PENDING=n TLS_CERT_PATH='' TLS_KEY_PATH=''
FRONT_INSPECT=n
TMP='' IS_WORKER=n CHECK_STARTED=n UPDATE_PENDING=n UI_LOCKED=n WORKER_LOCKED=n
TAIL_PID='' WAIT_PID='' AUTH_DIR=''

# English templates form the English message set; I18N_RU supplies Russian.
declare -Ar I18N_RU=(
  ['Enable automatic stable updates once a day? [y/N]: ']='Включить автоматическое обновление стабильных версий раз в сутки? [y/N]: '
  ['Recovering the interrupted update.']='Восстанавливаем прерванное обновление.'
  ['ROLLBACK_PASS previous release restored.']='ROLLBACK_PASS предыдущий выпуск восстановлен.'
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
  ['Workspace deletion timer, hours (0 = disabled) [%s]: ']='Таймер удаления пространства, часы (0 = отключено) [%s]: '
  ['Timer must be a whole number of hours from 0 to 9999999.']='Таймер должен быть целым числом часов от 0 до 9999999.'
  ['Workspace deletion timer: disabled.']='Таймер удаления пространства: отключён.'
  ['Workspace deletion timer: %s hours.']='Таймер удаления пространства: %s ч.'
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
  : > "$temporary" || die 'Cannot stage installer state.'
  chmod 600 "$temporary" || die 'Cannot secure installer state.'
  for name in SCHEMA UI_LANG MODE HOST USE_TOR ONION VERSION BUILD PERSONAL COMPLETE DISK_MIB RAM_MIB LEASE_HOURS STAGE ACTION STATUS CODE_HASH OLD_BUILD OLD_VERSION NEW_BUILD PUBLIC_READY TLS_MODE TLS_PENDING TLS_CERT_PATH TLS_KEY_PATH AUTO_UPDATES ACTIVE_SLOT BACKEND_STYLE OLD_SLOT OLD_STYLE; do
    printf '%s=%s\n' "$name" "${!name}" >> "$temporary" || die 'Cannot write installer state.'
  done
  mv -f -- "$temporary" "$STATE/settings" || die 'Cannot publish installer state.'
  sync -f "$STATE/settings" || die 'Cannot persist installer state.'
  sync -f "$STATE" || die 'Cannot persist installer state directory.'
}
load_state() {
  secure_dir "$STATE"; secure_file "$STATE/settings"
  local key value
  LEASE_HOURS=72 # Earlier schema-2 installations used 72 hours in both modes.
  AUTO_UPDATES=n ACTIVE_SLOT=a BACKEND_STYLE=single OLD_SLOT='' OLD_STYLE=''
  while IFS='=' read -r key value; do
    case "$key" in
      SCHEMA|UI_LANG|MODE|HOST|USE_TOR|ONION|VERSION|BUILD|PERSONAL|COMPLETE|DISK_MIB|RAM_MIB|LEASE_HOURS|STAGE|ACTION|STATUS|CODE_HASH|OLD_BUILD|OLD_VERSION|NEW_BUILD|PUBLIC_READY|TLS_MODE|TLS_PENDING|TLS_CERT_PATH|TLS_KEY_PATH|AUTO_UPDATES|ACTIVE_SLOT|BACKEND_STYLE|OLD_SLOT|OLD_STYLE)
        [[ $value != *$'\r'* && $value != *$'\n'* ]] || die 'Invalid installer state.'
        printf -v "$key" '%s' "$value";;
      *) die 'Invalid installer state.';;
    esac
  done < "$STATE/settings"
  [[ $AUTO_UPDATES =~ ^(y|n)$ && $ACTIVE_SLOT =~ ^[ab]$ && $BACKEND_STYLE =~ ^(single|slots)$ ]] || die 'Invalid updater state.'
  [[ -z $OLD_SLOT || $OLD_SLOT =~ ^[ab]$ ]] || die 'Invalid rollback slot.'
  [[ -z $OLD_STYLE || $OLD_STYLE =~ ^(single|slots)$ ]] || die 'Invalid rollback style.'
  if [[ -n $OLD_BUILD && -z $OLD_SLOT ]]; then OLD_SLOT=a OLD_STYLE=single; fi
  [[ $SCHEMA == 2 && $UI_LANG =~ ^(ru|en)$ && $MODE =~ ^(personal|service)$ && $USE_TOR =~ ^(y|n)$ ]] || die 'Invalid installer state.'
  [[ $HOST =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ && $HOST != *..* ]] || die 'Invalid installer state.'
  [[ $STAGE =~ ^[0-9]{1,2}$ && $DISK_MIB =~ ^[1-9][0-9]{0,6}$ && $RAM_MIB =~ ^[1-9][0-9]{0,6}$ ]] || die 'Invalid installer state.'
  [[ $LEASE_HOURS =~ ^(0|[1-9][0-9]{0,6})$ ]] || die 'Invalid installer state.'
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
    if [[ $UPDATE_PENDING == y && -n $OLD_BUILD ]]; then
      if ! (set -e; recover_update); then say 'Automatic rollback stopped; recovery journal preserved.' >&2; fi
      # The recovery ran in a subshell; reload its durable outcome before any
      # parent failure checkpoint, so stale OLD fields cannot resurrect a journal.
      load_state
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
KAIGEN_WEB_LEASE_HOURS=$LEASE_HOURS
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
  local port=$1 unit substate
  unit=$(active_unit)
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
  local candidate=${1:-$APP/current}
  [[ $candidate == "$APP/current" || $candidate == "$APP/releases/$BUILD" ]] || die 'Invalid candidate release path.'
  say 'Checking workspace creation and deletion...'
  if systemctl is-active --quiet kaigenweb-check.service; then
    secure_file "$STATE/check.owner"
    [[ $(systemctl show -p User --value kaigenweb-check.service) == kaigenweb && $(systemctl show -p ExecStart --value kaigenweb-check.service) == *"$candidate/bin/kaigen-webd"* ]] || die 'Another workspace check service is active.'
    systemctl stop kaigenweb-check.service
  fi
  rm -rf -- "$STATE/check" "$STATE/check.env" /run/kaigenweb/check
  if ss -ltnH '( sport = :18787 )' | read -r _; then die 'Workspace check port 18787 is already in use.'; fi
  if systemctl is-active --quiet kaigenweb-check.service; then die 'Another workspace check service is active.'; fi
  systemctl reset-failed kaigenweb-check.service 2>/dev/null || true
  mkdir -p "$STATE/check/disk" /run/kaigenweb/check/{ram,active}
  chown -R kaigenweb:kaigenweb "$STATE/check"
  chown -R kaigenweb:kaigenweb /run/kaigenweb/check
  sed -e 's/:878[78]$/:18787/' -e "s|$APP/current|$candidate|g" -e "s|$STATE/disk|$STATE/check/disk|" \
    -e 's|/run/kaigenweb/ram|/run/kaigenweb/check/ram|' -e 's|/run/kaigenweb/active|/run/kaigenweb/check/active|' \
    -e 's/PROOF_DIFFICULTY=18/PROOF_DIFFICULTY=12/' "$CFG/backend.env" > "$STATE/check.env"
  printf '%s\n' "$CODE_HASH" > "$STATE/check.owner"; sync -f "$STATE/check.owner"
  systemd-run --quiet --collect --unit=kaigenweb-check --property=User=kaigenweb \
    --property="EnvironmentFile=$STATE/check.env" --property=LimitMEMLOCK=infinity \
    --property=AmbientCapabilities=CAP_IPC_LOCK "$candidate/bin/kaigen-webd"
  CHECK_STARTED=y
  wait_backend 18787
  systemctl is-active --quiet kaigenweb-check.service || die 'Workspace check service exited.'
  local check_pid
  check_pid=$(systemctl show -p MainPID --value kaigenweb-check.service)
  ss -ltnpH '( sport = :18787 )' | grep -q "pid=$check_pid," || die 'Workspace check listener is not owned by its service.'
  local API_PORT=18787 API_EXTRA=() password identifier key login csrf selector cookie
  password=$(openssl rand -hex 18)
  identifier=$(create_workspace "$password")
  key=$(openssl ecparam -name prime256v1 -genkey 2>/dev/null | openssl ec -pubout -outform DER 2>/dev/null | base64 -w0 | tr '+/' '-_' | tr -d '=')
  AUTH_DIR=$(mktemp -d /run/kaigenweb-auth.XXXXXX)
  API_EXTRA=(--dump-header "$AUTH_DIR/headers")
  login=$(api auth/password "$(printf '{"identifier":"%s","password":"%s","publicKey":"%s"}' "$identifier" "$password" "$key")")
  csrf=$(jq -er .csrfToken <<< "$login")
  selector=$(jq -r '.workspaceSelector // empty' <<< "$login")
  local auth_cookie
  printf '%s\n' "$login" > "$AUTH_DIR/login"
  auth_cookie=$(python3 - "$AUTH_DIR/headers" "$AUTH_DIR/login" <<'PY_AUTH_COOKIE'
import json, sys
from http.cookies import SimpleCookie
import re

def response_cookie(raw_headers, login):
    if not isinstance(login, dict):
        raise SystemExit('Candidate authentication response is malformed')
    scoped, legacy = [], []
    valid = lambda value: isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{43}', value) is not None
    for raw in raw_headers:
        parsed = SimpleCookie()
        parsed.load(raw)
        for name, morsel in parsed.items():
            if name == '__Host-kaigen-device':
                target, suffix = legacy, ''
            elif name.startswith('__Host-kaigen-device-'):
                target, suffix = scoped, name.removeprefix('__Host-kaigen-device-')
                if not valid(suffix):
                    raise SystemExit('Candidate authentication cookie scope is malformed')
            else:
                continue
            if not valid(morsel.value):
                raise SystemExit('Candidate authentication cookie is malformed')
            target.append((name, morsel.value, suffix))
    if len(scoped) > 1 or len(legacy) > 1 or not (scoped or legacy):
        raise SystemExit('Candidate authentication cookies are ambiguous')
    selected = scoped[0] if scoped else legacy[0]
    if legacy and legacy[0][1] != selected[1]:
        raise SystemExit('Candidate authentication cookie aliases differ')
    if 'workspaceSelector' in login:
        selector = login['workspaceSelector']
        if not valid(selector) or not scoped or selected[2] != selector:
            raise SystemExit('Candidate authentication cookie scope mismatch')
    else:
        # Older official responses omit the selector and include both aliases.
        # Bind their actual Set-Cookie to this successful password-auth response.
        device = login.get('deviceId')
        if not valid(device) or selected[1] != device:
            raise SystemExit('Candidate authentication device mismatch')
    return selected[0] + '=' + selected[1], selected[2]
with open(sys.argv[1], encoding='iso-8859-1') as source:
    headers = [line.split(':', 1)[1].strip() for line in source if line.lower().startswith('set-cookie:')]
with open(sys.argv[2], encoding='utf-8') as source:
    login = json.load(source)
cookie, selector = response_cookie(headers, login)
print(json.dumps({'cookie': cookie, 'workspaceSelector': selector}))
PY_AUTH_COOKIE
  )
  cookie=$(jq -er .cookie <<< "$auth_cookie")
  selector=$(jq -r .workspaceSelector <<< "$auth_cookie")
  rm -f "$AUTH_DIR/headers" "$AUTH_DIR/login"
  rmdir "$AUTH_DIR"
  AUTH_DIR=''
  API_EXTRA=(-H "Cookie: $cookie" -H "X-Kaigen-Csrf: $csrf")
  [[ -z "$selector" ]] || API_EXTRA+=(-H "X-Kaigen-Workspace: $selector")
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
  location ~ "^/(?:space/|w/)?[A-Za-z0-9_-]{40,80}/api(?:/|$)" {
   proxy_http_version 1.1;
   proxy_set_header Connection "";
   proxy_set_header Authorization \$http_authorization;
   proxy_set_header Origin \$http_origin;
   proxy_set_header X-Real-IP \$remote_addr;
   proxy_set_header Host \$host;
   proxy_set_header X-Forwarded-Proto $([[ $tls == yes ]] && echo https || echo http);
   proxy_buffering off;
   proxy_request_buffering off;
   proxy_read_timeout 90s;
   proxy_pass http://127.0.0.1:$(active_port);
  }
  location = /api/v1/build-identity {
   default_type application/json;
   return 200 '{"status":"ok","buildId":"$BUILD"}';
  }
  location ~ "^/api/v1/install-manifest/[0-9a-f]{32}$" {
   proxy_pass http://127.0.0.1:$(active_port);
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
   proxy_pass http://127.0.0.1:$(active_port);
  }
EOF
  done
  echo ' }' >> "$CFG/nginx.conf"
}

# The distribution service is separate from our private Nginx instance. Only a
# package-pristine default instance may yield port 80 to this installation.
system_nginx_error() { die 'System Nginx is customized or changed; leave it untouched and inspect it before retrying.'; }
system_nginx_dropin() { printf '%s\n' '[Unit]' "ConditionPathExists=!$STATE/system-nginx.block"; }
system_nginx_marker() { printf '%s\n' 'Kaigen Web owns the distribution Nginx startup block v1'; }
system_nginx_state() {
  SYSTEM_NGINX_ACTIVE=$(systemctl show nginx.service -p ActiveState --value)
  SYSTEM_NGINX_ENABLED=$(systemctl is-enabled nginx.service 2>/dev/null || true)
  [[ $SYSTEM_NGINX_ACTIVE =~ ^(active|inactive)$ && $SYSTEM_NGINX_ENABLED =~ ^(enabled|disabled)$ ]] || system_nginx_error
}
system_nginx_pristine() {
  local owned=${1:-n} fragment file digest actual owner dropins expected conffiles inventory required=0
  [[ $(dpkg-query -W -f='${db:Status-Status}' nginx-common 2>/dev/null) == installed &&
     $(dpkg-query -W -f='${db:Status-Status}' nginx 2>/dev/null) == installed ]] || return 1
  fragment=$(systemctl show nginx.service -p FragmentPath --value) || return 1
  [[ $fragment == /usr/lib/systemd/system/nginx.service || $fragment == /lib/systemd/system/nginx.service ]] || return 1
  [[ -f $fragment && ! -L $fragment && $(stat -c %u "$fragment") == 0 ]] || return 1
  [[ ! -e /etc/systemd/system/nginx.service && ! -L /etc/systemd/system/nginx.service &&
     ! -e /run/systemd/system/nginx.service && ! -L /run/systemd/system/nginx.service ]] || return 1
  owner=$(dpkg-query -S "$fragment" 2>/dev/null || true)
  [[ $owner == "nginx-common: $fragment" ]] || return 1
  digest=$(awk '$2=="usr/lib/systemd/system/nginx.service" || $2=="lib/systemd/system/nginx.service" {print $1}' /var/lib/dpkg/info/nginx-common.md5sums)
  actual=$(md5sum < "$fragment"); actual=${actual%% *}
  [[ $digest =~ ^[a-f0-9]{32}$ && $actual == "$digest" ]] || return 1
  dropins=$(systemctl show nginx.service -p DropInPaths --value) || return 1
  expected=''
  [[ $owned != y ]] || expected=/etc/systemd/system/nginx.service.d/kaigenweb-owned.conf
  [[ $dropins == "$expected" ]] || return 1
  # Inspect directories as well: a newly written drop-in may not be loaded yet.
  for file in /etc/systemd/system/nginx.service.d /run/systemd/system/nginx.service.d /usr/lib/systemd/system/nginx.service.d; do
    [[ ! -L $file ]] || return 1
    if [[ -d $file ]]; then
      if [[ -n $expected ]]; then
        inventory=$(find "$file" -mindepth 1 -maxdepth 1 ! -path "$expected" -print -quit) || return 1
      else
        inventory=$(find "$file" -mindepth 1 -maxdepth 1 -print -quit) || return 1
      fi
      [[ -z $inventory ]] || return 1
    fi
  done
  conffiles=$(dpkg-query -W -f='${Conffiles}\n' nginx-common nginx) || return 1
  while read -r file digest; do
    [[ $file == /etc/nginx/* ]] || continue
    [[ $digest =~ ^[a-f0-9]{32}$ && -f $file && ! -L $file ]] || return 1
    actual=$(md5sum < "$file"); actual=${actual%% *}
    [[ $actual == "$digest" ]] || return 1
    case $file in /etc/nginx/nginx.conf|/etc/nginx/sites-available/default) ((required+=1));; esac
  done <<< "$conffiles"
  [[ $required == 2 ]] || return 1
  # Even an inactive custom vhost is administrator configuration, not stock.
  inventory=$(find /etc/nginx \( -type f -o -type l \) -print) || return 1
  while IFS= read -r file; do
    [[ $file != /etc/nginx/sites-enabled/default ]] || continue
    [[ ! -L $file && -f $file && $(stat -c %u "$file") == 0 ]] || return 1
    grep -qF " $file " <<< "$conffiles" || return 1
  done <<< "$inventory"
  [[ -f /etc/nginx/nginx.conf && -f /etc/nginx/sites-available/default &&
     -L /etc/nginx/sites-enabled/default &&
     $(readlink -f /etc/nginx/sites-enabled/default) == /etc/nginx/sites-available/default ]] || return 1
  for file in /etc/nginx/conf.d /etc/nginx/modules-enabled; do
    [[ -d $file && ! -L $file ]] || return 1
    inventory=$(find "$file" -mindepth 1 -maxdepth 1 -print -quit) || return 1
    [[ -z $inventory ]] || return 1
  done
  [[ -d /etc/nginx/sites-enabled && ! -L /etc/nginx/sites-enabled ]] || return 1
  inventory=$(find /etc/nginx/sites-enabled -mindepth 1 -maxdepth 1 ! -name default -print -quit) || return 1
  [[ -z $inventory ]] || return 1
}
system_nginx_stock_listener() {
  local line pid pids actual
  pid=$(systemctl show nginx.service -p MainPID --value)
  [[ $pid =~ ^[1-9][0-9]*$ && -d /proc/$pid &&
     $(readlink -f "/proc/$pid/exe") == /usr/sbin/nginx ]] || return 1
  while IFS= read -r line; do
    [[ -z $line ]] && continue
    # Every reported owner must be that service's master or one of its workers.
    pids=$(grep -oE 'pid=[0-9]+' <<< "$line") || return 1
    while IFS= read -r actual; do
      actual=${actual#pid=}
      [[ $actual == "$pid" || $(awk '$1=="PPid:"{print $2}' "/proc/$actual/status" 2>/dev/null) == "$pid" ]] || return 1
    done <<< "$pids"
    [[ $line == *"pid=$pid,"* ]] || return 1
  done < <(ss -ltnpH '( sport = :80 )')
}
inspect_system_nginx() {
  SYSTEM_NGINX_PACKAGE=absent SYSTEM_NGINX_ACTIVE=inactive SYSTEM_NGINX_ENABLED=absent
  if [[ $(dpkg-query -W -f='${db:Status-Status}' nginx 2>/dev/null || true) == installed ]]; then
    system_nginx_pristine || system_nginx_error
    SYSTEM_NGINX_PACKAGE=present
    system_nginx_state
    [[ $SYSTEM_NGINX_ACTIVE != active ]] || system_nginx_stock_listener || system_nginx_error
  else
    [[ ! -e /etc/nginx && ! -L /etc/nginx &&
       $(systemctl show nginx.service -p LoadState --value) == not-found &&
       ! -e /etc/systemd/system/nginx.service.d && ! -e /run/systemd/system/nginx.service.d ]] || system_nginx_error
  fi
}
snapshot_system_nginx() {
  [[ ! -e $STATE/system-nginx.before && ! -L $STATE/system-nginx.before ]] || system_nginx_error
  local fragment file digest
  {
    printf 'package=%s\nactive=%s\nenabled=%s\n' "$SYSTEM_NGINX_PACKAGE" "$SYSTEM_NGINX_ACTIVE" "$SYSTEM_NGINX_ENABLED"
    if [[ $SYSTEM_NGINX_PACKAGE == present ]]; then
      dpkg-query -W -f='package-version=${binary:Package} ${Version}\n' nginx-common nginx
      fragment=$(systemctl show nginx.service -p FragmentPath --value)
      sha256sum "$fragment"
      systemctl show nginx.service -p MainPID -p FragmentPath -p DropInPaths
      while read -r file digest; do [[ $file != /etc/nginx/* ]] || sha256sum "$file"; done < <(dpkg-query -W -f='${Conffiles}\n' nginx-common nginx)
    fi
  } > "$STATE/system-nginx.pristine.new"
  chmod 600 "$STATE/system-nginx.pristine.new"; sync -f "$STATE/system-nginx.pristine.new"
  mv "$STATE/system-nginx.pristine.new" "$STATE/system-nginx.pristine"
  printf '%s\n' 'schema=1' "package=$SYSTEM_NGINX_PACKAGE" "active=$SYSTEM_NGINX_ACTIVE" "enabled=$SYSTEM_NGINX_ENABLED" > "$STATE/system-nginx.before.new"
  chmod 600 "$STATE/system-nginx.before.new"
  sync -f "$STATE/system-nginx.before.new"
  mv "$STATE/system-nginx.before.new" "$STATE/system-nginx.before"
  sync -f "$STATE"
}
load_system_nginx_snapshot() {
  secure_file "$STATE/system-nginx.before"
  secure_file "$STATE/system-nginx.pristine"
  local key value count=0
  SYSTEM_NGINX_PACKAGE='' SYSTEM_NGINX_ACTIVE='' SYSTEM_NGINX_ENABLED=''
  while IFS='=' read -r key value; do
    ((count+=1))
    case "$count:$key:$value" in
      1:schema:1) ;;
      2:package:present|2:package:absent) SYSTEM_NGINX_PACKAGE=$value;;
      3:active:active|3:active:inactive) SYSTEM_NGINX_ACTIVE=$value;;
      4:enabled:enabled|4:enabled:disabled|4:enabled:absent) SYSTEM_NGINX_ENABLED=$value;;
      *) system_nginx_error;;
    esac
  done < "$STATE/system-nginx.before"
  [[ $count == 4 && ( $SYSTEM_NGINX_PACKAGE == present && $SYSTEM_NGINX_ENABLED != absent ||
                     $SYSTEM_NGINX_PACKAGE == absent && $SYSTEM_NGINX_ENABLED == absent && $SYSTEM_NGINX_ACTIVE == inactive ) ]] || system_nginx_error
}
verify_system_nginx_block() {
  secure_file "$STATE/system-nginx.block"
  secure_file /etc/systemd/system/nginx.service.d/kaigenweb-owned.conf
  cmp -s "$STATE/system-nginx.block" <(system_nginx_marker) &&
    cmp -s /etc/systemd/system/nginx.service.d/kaigenweb-owned.conf <(system_nginx_dropin) || system_nginx_error
}
prepare_system_nginx() {
  # Old installed versions have no trustworthy prestate. Never invent one.
  [[ -f $STATE/system-nginx.before ]] || system_nginx_error
  load_system_nginx_snapshot
  local was_package=$SYSTEM_NGINX_PACKAGE was_active=$SYSTEM_NGINX_ACTIVE was_enabled=$SYSTEM_NGINX_ENABLED
  local guard=/etc/systemd/system/nginx.service.d/kaigenweb-owned.conf
  if [[ -e $guard || -L $guard ]]; then
    verify_system_nginx_block
    systemctl daemon-reload
    if [[ $(dpkg-query -W -f='${db:Status-Status}' nginx 2>/dev/null || true) == installed ]]; then
      system_nginx_pristine y || system_nginx_error
    fi
  else
    inspect_system_nginx
    [[ $SYSTEM_NGINX_PACKAGE == "$was_package" && $SYSTEM_NGINX_ACTIVE == "$was_active" &&
       $SYSTEM_NGINX_ENABLED == "$was_enabled" ]] || system_nginx_error
    if [[ -e $STATE/system-nginx.block || -L $STATE/system-nginx.block ]]; then
      secure_file "$STATE/system-nginx.block"
      cmp -s "$STATE/system-nginx.block" <(system_nginx_marker) || system_nginx_error
    else
      system_nginx_marker > "$STATE/system-nginx.block"; chmod 600 "$STATE/system-nginx.block"
      sync -f "$STATE/system-nginx.block"
    fi
    [[ ! -L /etc/systemd/system/nginx.service.d ]] || system_nginx_error
    mkdir -p /etc/systemd/system/nginx.service.d
    secure_dir /etc/systemd/system/nginx.service.d
    system_nginx_dropin > "$guard.new"; chmod 600 "$guard.new"; sync -f "$guard.new"
    mv "$guard.new" "$guard"; sync -f /etc/systemd/system/nginx.service.d
    systemctl daemon-reload
    verify_system_nginx_block
  fi
  if systemctl is-active --quiet nginx.service; then
    system_nginx_pristine y && system_nginx_stock_listener || system_nginx_error
    systemctl stop nginx.service
  fi
  ! systemctl is-active --quiet nginx.service || system_nginx_error
}
check_system_nginx_uninstall() {
  # Validate before any package repair/purge or service stop. Older installs
  # without a snapshot retain their existing, independent uninstall path.
  [[ -e $STATE/system-nginx.before || -L $STATE/system-nginx.before ]] || return 0
  load_system_nginx_snapshot
  local guard=/etc/systemd/system/nginx.service.d/kaigenweb-owned.conf owned=n package_status
  if [[ -e $guard || -L $guard ]]; then
    verify_system_nginx_block
    owned=y
  elif [[ -e $STATE/system-nginx.block || -L $STATE/system-nginx.block ]]; then
    secure_file "$STATE/system-nginx.block"
    cmp -s "$STATE/system-nginx.block" <(system_nginx_marker) || system_nginx_error
  fi
  if [[ -e $STATE/system-nginx.restore || -L $STATE/system-nginx.restore ]]; then
    secure_file "$STATE/system-nginx.restore"
    [[ $(cat "$STATE/system-nginx.restore") == 'restore-original-active-v1' &&
       $SYSTEM_NGINX_PACKAGE == present && $SYSTEM_NGINX_ACTIVE == active ]] || system_nginx_error
  fi
  if [[ $SYSTEM_NGINX_PACKAGE == absent ]]; then
    package_status=$(dpkg-query -W -f='${db:Status-Status}' nginx 2>/dev/null || true)
    if [[ -e /etc/nginx || -L /etc/nginx || -e /usr/sbin/nginx || -L /usr/sbin/nginx ||
          -e /usr/lib/systemd/system/nginx.service || -e /lib/systemd/system/nginx.service ||
          ( -n $package_status && $package_status != not-installed ) ]]; then
      # A partial dpkg state must not reach repair and become a newly purgeable
      # package before its configuration has passed this ownership check.
      system_nginx_pristine "$owned" || system_nginx_error
    fi
  fi
}
restore_system_nginx() {
  [[ -e $STATE/system-nginx.before || -L $STATE/system-nginx.before ]] || return 0
  load_system_nginx_snapshot
  local was_package=$SYSTEM_NGINX_PACKAGE was_active=$SYSTEM_NGINX_ACTIVE was_enabled=$SYSTEM_NGINX_ENABLED
  local guard=/etc/systemd/system/nginx.service.d/kaigenweb-owned.conf restart=n intent="$STATE/system-nginx.restore"
  if [[ -e $intent || -L $intent ]]; then
    secure_file "$intent"
    [[ $(cat "$intent") == 'restore-original-active-v1' && $was_package == present && $was_active == active ]] || system_nginx_error
  fi
  if [[ ! -e $guard && ! -L $guard ]]; then
    if [[ -e $STATE/system-nginx.block || -L $STATE/system-nginx.block ]]; then
      secure_file "$STATE/system-nginx.block"
      cmp -s "$STATE/system-nginx.block" <(system_nginx_marker) || system_nginx_error
      rm -- "$STATE/system-nginx.block"
    fi
  else
    verify_system_nginx_block
    if [[ $was_package == present && $was_active == active ]] &&
       system_nginx_pristine y &&
       [[ $(systemctl is-enabled nginx.service 2>/dev/null || true) == "$was_enabled" &&
          $(systemctl show nginx.service -p ActiveState --value) == inactive ]]; then
      restart=y
      if [[ ! -e $intent ]]; then
        [[ ! -e $intent.new && ! -L $intent.new ]] || system_nginx_error
        printf '%s\n' 'restore-original-active-v1' > "$intent.new"
        chmod 600 "$intent.new"; sync -f "$intent.new"
        mv "$intent.new" "$intent"; sync -f "$STATE"
      fi
    elif [[ $was_package == present && $was_active == active && ! -e $intent ]]; then
      say 'System Nginx changed during installation; its current administrator state was preserved.'
    fi
    rm -- "$guard" "$STATE/system-nginx.block"
    rmdir /etc/systemd/system/nginx.service.d 2>/dev/null || true
  fi
  systemctl daemon-reload
  if [[ -e $intent ]]; then
    if system_nginx_pristine && [[ $(systemctl is-enabled nginx.service 2>/dev/null || true) == "$was_enabled" ]]; then
      case $(systemctl show nginx.service -p ActiveState --value) in
        inactive|failed) systemctl start nginx.service;;
        active) ;;
        *) system_nginx_error;;
      esac
      systemctl is-active --quiet nginx.service || system_nginx_error
    else
      say 'System Nginx changed during installation; its current administrator state was preserved.'
    fi
    rm -- "$intent"; sync -f "$STATE"
  fi
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
  local service path=/ tls_args=() services=("$(active_unit)" kaigenweb-nginx.service run-kaigenweb.mount)
  if [[ $TLS_MODE == auto ]]; then services+=(kaigenweb-acme.timer)
  else tls_args=(--cacert "$CFG/tls/fullchain.pem"); fi
  for service in "${services[@]}"; do
    systemctl is-enabled --quiet "$service" && systemctl is-active --quiet "$service" || die '%s is not enabled and active.' "$service"
  done
  wait_backend "$(active_port)"
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
  say "INSTALL_CHECK_PASS version=$VERSION mode=$MODE tor=$USE_TOR tls=$TLS_MODE leaseHours=$LEASE_HOURS services=enabled-and-active"
}

uninstall() {
  local list user
  check_system_nginx_uninstall
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
  systemctl disable --now kaigenweb@a.service kaigenweb@b.service kaigenweb-update.timer kaigenweb.service kaigenweb-nginx.service kaigenweb-tor.service kaigenweb-acme.timer 2>/dev/null || true
  systemctl stop kaigenweb-recovery.service kaigenweb-acme.service kaigenweb-check.service 2>/dev/null || true
  systemctl disable --now run-kaigenweb.mount 2>/dev/null || true
  rm -f /etc/systemd/system/kaigenweb{,-nginx,-tor,-acme}.service /etc/systemd/system/kaigenweb-acme.timer
  rm -f /etc/systemd/system/kaigenweb@{a,b}.service /etc/systemd/system/kaigenweb@.service /etc/systemd/system/kaigenweb-update.{service,timer}
  rm -f /etc/systemd/system/kaigenweb-recovery.service
  rm -f /etc/systemd/system/kaigenweb{,@a,@b,-nginx}.service.d/kaigen-update-recovery.conf
  rm -f /etc/systemd/system/run-kaigenweb.mount
  systemctl daemon-reload
  systemctl reset-failed kaigenweb.service kaigenweb-nginx.service kaigenweb-tor.service kaigenweb-acme.service kaigenweb-check.service 2>/dev/null || true
  [[ -z "$list" ]] || apt-get purge -y "${added[@]}"
  restore_system_nginx
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
  local deps=(ca-certificates curl jq nginx openssl iproute2 xz-utils libcap2-bin python3)
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
  if [[ $USE_TOR == y ]] && ! grep -qx tor "$STATE/packages.before"; then
    systemctl disable --now tor.service tor@default.service 2>/dev/null || true
  fi
}

# Release checks and extraction use only the official repository. Numeric versions
# compare by components, including older four/five-component Kaigen versions.
resolve_stable_release() {
  local installed=${1:-0} page count
  : > "$TMP/releases.ndjson"
  for ((page=1;page<=100;page++)); do
    fetch -o "$TMP/releases.page" "https://api.github.com/repos/$REPO/releases?per_page=100&page=$page" || return 1
    count=$(jq -er 'if type=="array" then length else error("Expected release list") end' "$TMP/releases.page") || return 1
    jq -c '.[]' "$TMP/releases.page" >> "$TMP/releases.ndjson" || return 1
    ((count==100)) || break
    ((page<100)) || die 'Release pagination exceeded its safety limit.'
  done
  python3 - "$TMP/releases.ndjson" "$TMP/release.json" "$installed" <<'PY_RELEASE'
import json, pathlib, re, sys
source, target, installed = sys.argv[1:]
def numeric(value):
    if not isinstance(value, str) or not re.fullmatch(r'[vV]?[0-9]+(?:\.[0-9]+)*', value): return None
    parts = tuple(int(part) for part in value.lstrip('vV').split('.'))
    while len(parts) > 1 and parts[-1] == 0: parts = parts[:-1]
    return parts
current = numeric(installed)
if current is None: raise SystemExit('Installed version is not numeric; refusing a downgrade')
releases = []
for line in pathlib.Path(source).read_text().splitlines():
    release = json.loads(line)
    version = numeric(release.get('tag_name'))
    if (version is None or release.get('draft') is not False or release.get('prerelease') is not False
            or 'rc' in str(release.get('name', '')).lower() or 'rc' in release['tag_name'].lower()): continue
    releases.append((version, release))
if not releases: raise SystemExit('No stable numeric official release exists')
version, release = max(releases, key=lambda item: item[0])
if version <= current:
    pathlib.Path(target).unlink(missing_ok=True)
    print('NO_UPDATE')
else:
    pathlib.Path(target).write_text(json.dumps(release))
    print(release['tag_name'])
PY_RELEASE
}

extract_verified_archive() {
  python3 - "$1" "$2" "$3" <<'PY_ARCHIVE'
import hashlib, os, pathlib, re, stat, sys, tarfile
archive, digest, destination = sys.argv[1:]
if not re.fullmatch(r'[a-fA-F0-9]{64}', digest): raise SystemExit('Invalid archive SHA-256')
flags = os.O_RDONLY | os.O_NOFOLLOW
fd = os.open(archive, flags)
with os.fdopen(fd, 'rb') as source:
    if not stat.S_ISREG(os.fstat(source.fileno()).st_mode): raise SystemExit('Archive is not a regular file')
    h = hashlib.sha256()
    while chunk := source.read(1024 * 1024): h.update(chunk)
    if h.hexdigest() != digest.lower(): raise SystemExit('Archive SHA-256 mismatch')
    source.seek(0)
    with tarfile.open(fileobj=source, mode='r:gz') as package:
        members = package.getmembers()
        names, total = set(), 0
        if len(members) > 100000: raise SystemExit('Archive member limit exceeded')
        for member in members:
            name = member.name.removeprefix('./').rstrip('/')
            if name in ('', '.') and member.isdir(): continue
            parts = pathlib.PurePosixPath(name).parts
            if (not parts or name.startswith('/') or any(x in ('.', '..') for x in parts)
                    or not re.fullmatch(r'[A-Za-z0-9_./+@-]+', name) or name in names):
                raise SystemExit('Unsafe or duplicate archive path')
            if not (member.isfile() or member.isdir()): raise SystemExit('Unsupported archive member type')
            if member.size < 0: raise SystemExit('Invalid member size')
            total += member.size
            if total > 2 * 1024**3: raise SystemExit('Archive expanded size limit exceeded')
            names.add(name)
        destination = pathlib.Path(destination)
        destination.mkdir(mode=0o700, parents=False, exist_ok=False)
        for member in members:
            name = member.name.removeprefix('./').rstrip('/')
            if name in ('', '.') and member.isdir(): continue
            target = destination.joinpath(name)
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            if member.isdir():
                target.mkdir(exist_ok=True, mode=0o755)
                continue
            stream = package.extractfile(member)
            with open(target, 'xb') as output:
                while chunk := stream.read(1024 * 1024): output.write(chunk)
            os.chmod(target, 0o755 if member.mode & 0o111 else 0o644)
PY_ARCHIVE
}

download_release() {
  local asset digest target
  if [[ ! -s $TMP/release.json ]]; then
    [[ $(resolve_stable_release 0) != NO_UPDATE ]] || die 'No installable release exists.'
  fi
  VERSION=$(jq -er '.tag_name | select(test("^[vV]?[0-9]+(\\.[0-9]+)*$"))' "$TMP/release.json")
  VERSION="v${VERSION#[vV]}"
  asset=$(jq -cer '[.assets[] | select(.name | test("^Kaigen-Web-Debian13-Nginx-[A-Za-z0-9._-]+\\.tar\\.gz$"))] | if length==1 then .[0] else error("Web bundle missing or ambiguous") end' "$TMP/release.json")
  digest=$(jq -er '.digest | select(test("^sha256:[a-f0-9]{64}$"))' <<< "$asset")
  # Use the validated original tag; normalization of VERSION does not change URLs.
  local tag; tag=$(jq -er .tag_name "$TMP/release.json")
  say 'Downloading official Kaigen Web %s...' "$VERSION"
  fetch -o "$TMP/bundle.tar.gz.part" "https://github.com/$REPO/releases/download/$tag/$(jq -r .name <<< "$asset")"
  printf '%s  %s\n' "${digest#sha256:}" "$TMP/bundle.tar.gz.part" | sha256sum -c -
  mv "$TMP/bundle.tar.gz.part" "$TMP/bundle.tar.gz"; sync -f "$TMP/bundle.tar.gz"
  rm -rf -- "$TMP/bundle"
  extract_verified_archive "$TMP/bundle.tar.gz" "${digest#sha256:}" "$TMP/bundle"
  BUILD=$(tr -d '\r\n' < "$TMP/bundle/release-id")
  [[ $BUILD =~ ^[A-Za-z0-9][A-Za-z0-9._-]{11,79}$ ]] || die 'Invalid Web build identity.'
  [[ $(cat "$TMP/bundle/payload/ui/kaigen-build-id") == "$BUILD" ]] || die 'UI identity mismatch.'
  for target in bin/kaigen-webd lib/Kaigen/libtoxcore.so.2.24.0 TorExpertBundle/tor/tor ui/index.html; do
    [[ -s $TMP/bundle/payload/$target ]] || die 'Release payload is incomplete.'
  done
  RELEASE_DIGEST=${digest#sha256:}
  target="$APP/releases/$BUILD"
  if [[ -e $target ]]; then
    [[ -f $target/.bundle-sha256 && $(cat "$target/.bundle-sha256") == "$RELEASE_DIGEST" && -x $target/bin/kaigen-webd ]] || die 'Release directory collision.'
  else
    if [[ -e $target.staging || -L $target.staging ]]; then
      [[ -d $target.staging && ! -L $target.staging && -f $target.staging/.install-owned && $(cat "$target.staging/.install-owned") == "$RELEASE_DIGEST" ]] || die 'Unmanaged release staging directory.'
      rm -rf -- "$target.staging"
    fi
    mkdir -m 755 "$target.staging"
    printf '%s\n' "$RELEASE_DIGEST" > "$target.staging/.install-owned"
    cp -a "$TMP/bundle/payload/." "$target.staging/"
    ln -s libtoxcore.so.2.24.0 "$target.staging/lib/Kaigen/libtoxcore.so.2"
    chmod -R a+rX "$target.staging"
    chmod 755 "$target.staging/bin/kaigen-webd" "$target.staging/TorExpertBundle/tor/tor"
    printf '%s\n' "$RELEASE_DIGEST" > "$target.staging/.bundle-sha256"
    mv "$target.staging" "$target"; sync -f "$APP/releases"
  fi
  if [[ $ACTION == install ]]; then atomic_current "$BUILD"; fi
  save_state
}

active_port() { if [[ $ACTIVE_SLOT == b ]]; then printf 8788; else printf 8787; fi; }
active_unit() { if [[ $BACKEND_STYLE == single ]]; then printf kaigenweb.service; else printf 'kaigenweb@%s.service' "$ACTIVE_SLOT"; fi; }
atomic_current() {
  [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9._-]{11,79}$ && -d $APP/releases/$1 ]] || die 'Invalid release pointer.'
  [[ ! -e $APP/current.new && ! -L $APP/current.new ]] || die 'Unfinished release pointer needs recovery.'
  ln -s "$APP/releases/$1" "$APP/current.new" || die 'Cannot stage the release pointer.'
  mv -Tf "$APP/current.new" "$APP/current" || die 'Cannot replace the release pointer.'
  sync -f "$APP" || die 'Cannot persist the release pointer.'
}
write_slot_service() {
  local slot=$1 release=$2
  [[ $slot =~ ^[ab]$ && $release == "$BUILD" ]] || die 'Invalid slot service input.'
  cat > "/etc/systemd/system/kaigenweb@$slot.service" <<EOF
[Unit]
Description=Kaigen Web slot $slot
After=network.target run-kaigenweb.mount
Requires=run-kaigenweb.mount
[Service]
User=kaigenweb
Group=kaigenweb
EnvironmentFile=$CFG/backend.env
EnvironmentFile=$CFG/slot-$slot.env
ExecStart=$APP/releases/$release/bin/kaigen-webd
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
  chmod 644 "/etc/systemd/system/kaigenweb@$slot.service"
}
stop_clean_writer() {
  local unit=$1
  systemctl stop "$unit" || die 'Backend stop failed.'
  [[ $(systemctl show -p MainPID --value "$unit") == 0 && $(systemctl show -p Result --value "$unit") == success && $(systemctl show -p ExecMainCode --value "$unit") == 1 && $(systemctl show -p ExecMainStatus --value "$unit") == 0 ]] || die 'Backend has no verified clean exit; keeping the predecessor untouched.'
  python3 - "$STATE/.disk.kaigen-webd.lock" <<'PY_LOCK'
import fcntl, os, stat, sys
fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOFOLLOW)
try:
    locked = os.fstat(fd)
    if not stat.S_ISREG(locked.st_mode): raise SystemExit('Storage lock is not a regular file')
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    named = os.stat(sys.argv[1], follow_symlinks=False)
    if (locked.st_dev, locked.st_ino) != (named.st_dev, named.st_ino): raise SystemExit('Storage lock changed')
finally: os.close(fd)
PY_LOCK
}

recover_update() {
  [[ -n $OLD_BUILD ]] || return 0
  say 'Recovering the interrupted update.'
  secure_file "$STATE/nginx.previous"
  [[ -x $APP/releases/$OLD_BUILD/bin/kaigen-webd ]] || die 'Predecessor release is missing.'
  local unit
  # Stop every managed writer before changing its release or restarting another.
  for unit in kaigenweb.service kaigenweb@a.service kaigenweb@b.service; do
    if systemctl is-active --quiet "$unit"; then stop_clean_writer "$unit"; fi
  done
  restore_update_files
  systemctl daemon-reload || die 'Cannot reload service configuration.'
  for unit in kaigenweb.service kaigenweb@a.service kaigenweb@b.service; do
    [[ $unit == "$(active_unit)" ]] || systemctl disable "$unit" 2>/dev/null || true
  done
  systemctl enable --now "$(active_unit)" || die 'Cannot restart the predecessor.'
  wait_backend "$(active_port)"
  systemctl reload kaigenweb-nginx.service || die 'Cannot restore the public route.'
  say 'ROLLBACK_PASS previous release restored.'
}

update() {
  recover_update
  local old_version=$VERSION old_build=$BUILD latest old_unit new_slot new_port
  latest=$(resolve_stable_release "$VERSION")
  if [[ $latest == NO_UPDATE ]]; then
    COMPLETE=y STATUS=complete; save_state; configure_auto_updates canonical
    say 'NO_UPDATE installed=%s' "$VERSION"; return
  fi
  prepare_boot_recovery canonical
  # The journal becomes durable before a downloaded candidate changes settings.
  OLD_BUILD=$BUILD OLD_VERSION=$VERSION OLD_SLOT=$ACTIVE_SLOT OLD_STYLE=$BACKEND_STYLE
  cp "$CFG/nginx.conf" "$STATE/nginx.previous"; chmod 600 "$STATE/nginx.previous"; sync -f "$STATE/nginx.previous"
  save_state; UPDATE_PENDING=y
  download_release
  NEW_BUILD=$BUILD; save_state
  check_workspace "$APP/releases/$NEW_BUILD"
  old_unit=$(active_unit)
  if [[ $ACTIVE_SLOT == a ]]; then new_slot=b new_port=8788; else new_slot=a new_port=8787; fi
  [[ $(systemctl show -p MainPID --value "kaigenweb@$new_slot.service" 2>/dev/null || true) =~ ^(0)?$ ]] || die 'The inactive slot is still running.'
  write_slot_service "$new_slot" "$BUILD"
  printf 'KAIGEN_WEB_BIND=127.0.0.1:%s\nKAIGEN_RELEASE_ROOT=%s\nLD_LIBRARY_PATH=%s/lib/Kaigen\nKAIGEN_WEB_RESOURCE_ROOT=%s\n' "$new_port" "$APP/releases/$BUILD" "$APP/releases/$BUILD" "$APP/releases/$BUILD" > "$CFG/slot-$new_slot.env"
  chmod 600 "$CFG/slot-$new_slot.env"; sync -f "$CFG/slot-$new_slot.env"
  stop_clean_writer "$old_unit"
  atomic_current "$BUILD"
  ACTIVE_SLOT=$new_slot BACKEND_STYLE=slots
  save_state
  personal_entry
  systemctl daemon-reload
  systemctl enable --now "$(active_unit)"; wait_backend "$new_port"
  write_nginx yes; systemctl reload kaigenweb-nginx.service
  verify_install
  systemctl disable "$old_unit"
  OLD_BUILD='' OLD_VERSION='' NEW_BUILD='' OLD_SLOT='' OLD_STYLE='' UPDATE_PENDING=n COMPLETE=y STATUS=complete
  save_state; rm -f "$STATE/nginx.previous"; configure_auto_updates canonical
  say 'UPDATE_PASS previous=%s current=%s slot=%s' "$old_version" "$VERSION" "$ACTIVE_SLOT"
}

# The legacy adapter is generated from web/installer/install-kaigen-web.sh.
# Packaging rejects any drift between its exact bytes and the embedded version.
prepare_boot_recovery() {
  local layout=$1 state_dir unit backend nginx
  if [[ $layout == canonical ]]; then state_dir=$STATE/updater; unit=kaigenweb-recovery; nginx=kaigenweb-nginx.service
  else state_dir=/var/lib/kaigen-webd/updater; unit=kaigen-webd-recovery; nginx=nginx.service; fi
  configure_auto_updates "$layout"
  if [[ $layout == legacy ]]; then
    /bin/bash /var/lib/kaigen-webd/updater/legacy-adapter.sh prepare-recovery
    return
  fi
  cat > "/etc/systemd/system/$unit.service" <<EOF
[Unit]
Description=Recover interrupted Kaigen Web updates before any writer
Before=$nginx
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash --noprofile --norc -p $state_dir/updater.sh --recover-boot --layout $layout
TimeoutStartSec=120
UMask=0077
[Install]
WantedBy=multi-user.target
EOF
  local backends=(kaigenweb.service kaigenweb@a.service kaigenweb@b.service)
  [[ $layout != legacy ]] || backends=(kaigen-webd@a.service kaigen-webd@b.service)
  for backend in "${backends[@]}"; do
    mkdir -p "/etc/systemd/system/$backend.d"
    cat > "/etc/systemd/system/$backend.d/kaigen-update-recovery.conf" <<EOF
[Unit]
Requires=$unit.service
After=$unit.service
[Service]
ExecCondition=+/bin/bash --noprofile --norc -p $state_dir/updater.sh --check-backend $backend --layout $layout
EOF
  done
  mkdir -p "/etc/systemd/system/$nginx.d"
  printf '[Unit]\nRequires=%s.service\nAfter=%s.service\n' "$unit" "$unit" > "/etc/systemd/system/$nginx.d/kaigen-update-recovery.conf"
  systemctl daemon-reload
  systemctl enable "$unit.service"
  # Run the empty-journal check before starting a transaction. RemainAfterExit
  # keeps the dependency satisfied during normal candidate startup. Reboot runs it again.
  systemctl start "$unit.service"
}

recovery_cli() {
  [[ $EUID == 0 ]] || exit 1
  local action=$1 backend='' layout='' unit; shift
  if [[ $action == --check-backend ]]; then backend=${1:-}; shift; fi
  [[ ${1:-} == --layout && ${2:-} =~ ^(canonical|legacy)$ && $# == 2 ]] || exit 1
  layout=$2
  if [[ $layout == legacy ]]; then
    secure_dir /var/lib/kaigen-webd/updater
    secure_file /var/lib/kaigen-webd/updater/legacy-adapter.sh
    if [[ $action == --check-backend ]]; then
      [[ $backend =~ ^kaigen-webd@([ab])\.service$ ]] || exit 1
      /bin/bash /var/lib/kaigen-webd/updater/legacy-adapter.sh check-slot --slot "${BASH_REMATCH[1]}"
    else /bin/bash /var/lib/kaigen-webd/updater/legacy-adapter.sh recover-pending --boot; fi
    return
  fi
  load_state
  if [[ $action == --check-backend ]]; then [[ $backend == "$(active_unit)" ]]; return; fi
  exec 7>/run/kaigenweb-install.lock
  if ! flock -n 7; then
    # The preparing installer owns fd9 and starts the still-empty boot gate.
    [[ -z $OLD_BUILD ]] && return 0
    die 'Another update transaction is live; boot recovery refused.'
  fi
  if [[ -n $OLD_BUILD ]]; then
    # All managed backends depend on this oneshot; a live writer requires the
    # manual --update recovery route, which first verifies its clean stop.
    for unit in kaigenweb.service kaigenweb@a.service kaigenweb@b.service; do
      [[ $(systemctl show -p MainPID --value "$unit" 2>/dev/null || true) =~ ^(0)?$ ]] || die 'A backend is already live; use manual update recovery.'
    done
    restore_update_files
  fi
  for unit in kaigenweb.service kaigenweb@a.service kaigenweb@b.service; do
    [[ $unit == "$(active_unit)" ]] || systemctl disable "$unit" 2>/dev/null || true
  done
  systemctl enable "$(active_unit)"
  # Queue without waiting: the writer itself requires this recovering unit.
  systemctl --no-block start "$(active_unit)"
}

restore_update_files() {
  secure_file "$STATE/nginx.previous"
  [[ -x $APP/releases/$OLD_BUILD/bin/kaigen-webd ]] || die 'Predecessor release is missing.'
  if [[ -e $APP/current.new || -L $APP/current.new ]]; then
    [[ -L $APP/current.new ]] || die 'Unmanaged pending release pointer.'
    local pending; pending=$(readlink "$APP/current.new")
    [[ $pending == "$APP/releases/$OLD_BUILD" || ( -n $NEW_BUILD && $pending == "$APP/releases/$NEW_BUILD" ) || $pending == "$APP/releases/$BUILD" ]] || die 'Pending pointer is outside this update journal.'
    rm -- "$APP/current.new"
  fi
  atomic_current "$OLD_BUILD"
  cp "$STATE/nginx.previous" "$CFG/nginx.conf" || die 'Cannot restore Nginx configuration.'
  sync -f "$CFG/nginx.conf" || die 'Cannot persist restored Nginx configuration.'
  BUILD=$OLD_BUILD VERSION=$OLD_VERSION ACTIVE_SLOT=$OLD_SLOT BACKEND_STYLE=$OLD_STYLE
  OLD_BUILD='' OLD_VERSION='' NEW_BUILD='' OLD_SLOT='' OLD_STYLE='' UPDATE_PENDING=n
  COMPLETE=y STATUS=complete; save_state || die 'Cannot commit restored installer state.'
  rm -f "$STATE/nginx.previous" || die 'Cannot retire the completed rollback backup.'
  sync -f "$STATE" || die 'Cannot persist rollback completion.'
}

write_legacy_adapter() {
  local destination=$1 temporary
  [[ ! -L $destination ]] || die 'Unsafe legacy adapter destination.'
  temporary=$(mktemp "$destination.new.XXXXXX") || die 'Cannot stage the legacy adapter.'
  if ! base64 -d <<'KAIGEN_LEGACY_ADAPTER_BASE64' | gzip -d > "$temporary"; then
H4sIAAAAAAACCu29a3vbRrIg/Hn4K9qwEpC2QFLyLZHCzMgSbWut26GkJF5bwwckmiJGIMAAoGRF
0vz2far6gu5GA6Q8yfvu2d0854xF9K26urq6urouT590FlnaGYVxh8bXZORn00ZGc+LRRULm4ZxO
/DBq7L877a25X+IvudtYzPzsinQ33zQaKfWDJI5uycng+P1g57DnfvTDSxqTX+mIhHGW+1FEU7eo
d7hztPO+vzc83Bl87A967lNy6Mf+JQ3I6JbY2raVxqf9wS/7u/3h+Sk0vcLa3g0dBZY67wfH5yeV
lQ6Oz4Y7w5PjwVnP/eHND2/MsrdF2Q9uo7Gze7Z/fNRzOVRu4+350d5Bfzg4Pj7ruW5jZ7D7Yf+X
/vBk5+yD+vv0w87mq9fal7Od93340P/tpL971t8b7p4PBv2js+Ggf9DfOcWy3Q/93Y9DAAR+Dfq7
x7/0B5+Gb2G0iR9ltHF0fDTcPzrrDwCyX/r86/7R6dnOwQEDy1m7+7iz/74PFYvPW96D0zjrn54N
D4/3+pZKULbldR+cRgMWvtkid2SehnE+IW5/MDgebJHvsi+xS5y1Zw75+fvNbUK/hjnZ2CYPjTjJ
qdaiqArFaZLkw7mfT40632VQRwXTIc7aBmtDf1+EKR2Ok9nMjwNsyf8m3jVWIz93AnrdiRdRRDZ/
/n6D3N8TgJ04A9Y4kC3CjMzCLAvjyy3CB2gsMv8SoW4QMvZz8tNPbv/4nds4h+9bghK9gpLa2ZR8
5p/vF/PAz+l9mkTRyB9f3S9iXnJBmp43WsRBRMne/oDcE8/z0/E0vKbk3f5Bv/jpZVN/89Vrwqil
RT57XpzEXhjnNPXHeXhNLxqNsyklvLfZIsvJOIlzP4xJSiPqZ9QLg3Uy8+NwQrO8zTpcJ3P/Nkr8
ADe3shPWG6IgCkcdtuvgzzz5Ok5S2s6S9mZ782W7W/RwlqT9r3Oa5m8ZDH4cyE4WYSeMA/q1Pc1n
EbkJ8ylRivi4o0UYBQil2jRdxHk4o53f8+SrF87mSZp37qJwlP0ejcP5lKbtLFmfp8k1jf14TNv/
ypJ4fdDf2Tvst/Ov+UO7caRjSiwXgf2cEYO4geZJc07TLIn96D6j6XU4pq31hlHvw/Hp2dHOYX/d
7ODs4HS42x+cwSRsZR/7n9qN/vG7xkOjcTMNI0qazbWnrdY2CRIkr4wykg3jBiGELKWi+5SOk2ua
enMaB2F8eT+e0vGVl0VJfj9P6dxPqcer3LYI51M4wvY2juB5oyTJW0TnInm6oEUN6K1Fsmk4ybc5
wHIPuayY8H2YEZ9c+9GCuttEYVP6iPTrnI5zGnjjRZrSOPc4kdaMUdXENm4l6zTmjZRaMybfTsoI
QZjScZ6kt+42UVm83jHftjU9i32udD0JI4BdOyms3XJusLx3wTY0+C9plivD8ANIH8hgLi1iniYa
dUzvPW9Ko3mLIKPk7L4ryp+1OK89j6/i5CYmfnq5mNE4RwbLatHMHzcIm1AjSGLaaIQT8vkzcdbk
UeSQJz3ibrjk4mKb5FMK++PzZ7LWP9/fIx79nXTJxUWBhcEiJn5G4ERpu6yq90fpEFFbWA5DOA5y
muUeHPxttzEJ6wD7/nvirLEdht+MnVkqL3aqOif6lY7Jjz8D51NZssf3eztKxlcNQibwL/Fi8mMx
g504yac0tYhJfh4mMclTP85gTZMYZpYu4jiML/m8pHzTP9sd7u0Pes5aU57HpEPzsQpOyzEEItaC
t+3ApDK1ytnOWX8Ip5rR7bWf4hmjdN2Rop2X5X5O1aH2ds52LMBZelFbiSUtN0zmeVUjzjNOl7fq
cFaUqc0F6znYP/q4pDnnaGrro/f7R78Nd37Z2T/YeVtCGqxFfBnGXztZmNPM86/9MPJHEVW6LffW
P4Ku9pb0RWPoKKjt6fzk9GzQ3zms7Eql28U8y1Pqz9rjJJ5oGOoPzt5KyjE7imie0Xic3s5za6P+
ycHxp+GH42PArtJVJ6UxvfEjb5okV1knoPMouVUA8hBCx3JnONo/s8CR3WY5nQX8X3Vm/2gL8UDp
7WD/cP/stGJOK/TVDiy98X1T9N2JwlmYZ4hSpfrh8fnRmWUirm30dBFzkfXL180AgGjPkkWcuyoA
5yd7sHH/x/H54GjnoOesiQ3YYQJJ6ik8Rd08x+dn/eHp0c7J6YdjiQ/BHYoNniaLnHpZ7M+zqc4x
eA+7H/qHO8O35/sHe8P9vZ4rpETvesOtqHzQf7+z+6nnRvTSH99611230WAVzgY7R6eMAQ+1e1G5
WICO96tyKbKz0w879mKxP6prcO5gL2SgFde7UoXjg73h6dnxyUl/r3ICuztHe/u4eNX9KHXOdgZn
w52zs/7hyZnsVWyrg/2jPr+Vik+/9t+Ku20Dz7FhQEehH/NrUpSM/Ygk2ZCzxgZRflh2RpJJEdDh
h/WEOGtFG/2o3sOxSNFKubfhaf+UZFMaRQgZCcIMeFrvdHej+2O3QUhb75oN6Kzd7e/B7Zf0esRl
s+Fn+t0v/cEpIEypsPHCtYG08QJPVn6tbLsg5zP8ROE1HQYUhAEaj0OacVSZwkRPSDkwdkrzRQpS
wSRJxR11GPszuMYQ5GSEbedxHpHxIo0Ik/myxUxedGZXOZ3NCW7ueRLGOckyft0gxLg9E2dNHQVQ
g+IYIeFEGSnMPH6b8rzfFyHNiT/3x1O6KdiYlGaIEE2wHHDDGrYJ3FclI1Bk1JgcwbxQ5MLPNMsJ
UgrAdxNGEYmTnMySIJzcEtYvrvkkBGT7wSzMh1wCLlDsxSB7KbK1A+hFiVCR4x0uo2nCsUN6/yb/
/Ox7kx3vXdf78eLu9cuHNW3xd7g4D4NnGYhXJZkboY8Tee1AkE3sz2/zaRK/aBCiq4OctSZfRS9g
0k4+m6uHGp9v+zf8D/fQeDpLAvKm21UnBL1BIR+IeCWslGdvNO8w+B1Qg5x8GvIyt8Eu52TqZ9Mo
HK2TJFvHZcMfKV0nIMytAxGtk9xP4brT4GCvcxytk4BmeRgzabUHddt+enn9eWPrAuTuGK+Z7cki
imZ+Pp42U9dYFld01doiqR9mlJwi0fa/hnnT3Y+v/SgMiLh9nX7Y8TZfvXZbjUnkX2akR5KsfTwc
7B0fHXwi9+zX0fG744OD418bk4BVSOY0bkrIsWWrgUqNJGtPAiyeBOvETUduC+4gWbJIx3SL3efZ
LAAX7dPh/umg/74JzeBDk1VsA2ripNlqtbN8OEsCap2MoLkwwx59ktLLReSn7CLZwtGmpCcWhKt8
mqyAqR7G00V8RbZ6HMI2nKfNje7mS/KMwD+tLTJts4O+iXVbYg7T9pR+ZZhutuAuw/5uR8kNTZu1
8HKkA7vGReSgchAySq+aXQ4k4JSTCsM6/JWM/tVjldeBCdCem25d/sEwPffHV6CTw+bw34zORjSF
leVF7Uua848cFfAf8DogyyT3I6A7mjdb66Qry8MJiWjc5A1b5Gey0YX/6ubJKhOU1Aj9OqY0oIFb
jAkcndcJYwFoAbkAi/R4WRt+tVM6S67pPKWT8GvTbXfcVjvN8jScN92O0rkgNX5SNF13nbhtQFIc
iP7CLAhxrUBTGMYLqrWe+2nO8IZbuH2ySOlJkoVfT0A9Cx232ljHHLMJ1MhaJylC0M5y+AnLiVDC
dz++bX5loLURNgAOUIIfsbk+G/Ef9GlhAzve//S9P7rej8N25/k/vIvn7jqO3RJA4IEJy9zaKvVb
XsTzOPMnFNoGi3kUjv2cSq4BGLGgOslJU2IWCLWJY+vItu6M8zhbzIF50oI1ccrIb+e0PBbvMwv/
oOQn0q1jdbwfqGr0w4j9eU/tzRyI1fmZbHKG8OzZizqSp1/nfhzQAIerpny549p+EDBSkmX6ASCJ
D2hOKbLWb8+uAMfIE7rJmy4qp+FinfXegTi7DoqpLB8mV+z3f5utmPvpJc1JT5vsv5IwnsutaKnf
ZpPnWBGYOEsXKiLYT4GyV6+qSE0AWNo6fCw2yIrdwn/WiTJFgcKs6dccdJC4mxgkek/s1IWTgcGx
Ttyv/NBNFvl8kZcBNk8+ppuwnHysg/ZNGuqnn2REWRtFLDk0zlTBGUyffE+6ycbGBqFRRkk3ef3y
ZatRSE0NYmiRrZIWiLW4m/2cDtk3LtgyXWSNbKsLflLNSDQpeRtE50JK1uRhVcqVCnHlhoN7R9w0
gKKZuIDSrT615jggnmeRt+c3AfFOtHufUqVTvF/p0LwVynlRbN4BbZ0ZD2DWHkWdVfqreD+z9gvv
NjQOHtPtktc36zC8FuEvZ48ZznjD6+RJCv9vHeYsSf+sIebR4vISbuhDVCbBSZh1otuUjsLUjspk
NMleEln7LwFgnMT/WqTUG0chjXMrGLusyl8MyDwfgp4vvMTHTSsgsp1XgMLaLFJfqPu/FbDAz/3O
JU3CeSUhvKfJ/gmBiiOLMubbBntdP9r1628aT3uKto5wvv/I/oz366pOsZyEAY3zML81xwA2Cs/Y
YUDTIZx3ICsY79zEeOcmxTu31OcArFkFrLa39DVtUCvsp/91sIsgWPY7SLh0Ns9vcRKFqmgSoi5J
Y/UeCLMkIh7adRBQHOXknlymdE6830m7pDN6q1gzgHgtLBqy21kUxleZ0PpUjviEjxnIvyaPHp0P
ioqphSKoA7qYQowko3/RcV5Aw1+OQF/trDXzFJQ27pcUDF1+qj7cWlIPWbTnqid5ubko/mwPvYu7
7vqbHw1VlPVYDNltAEFkqtlFOESCHIZBg6i/8KT289JRXUfxBehKR6jJ1Cez0sYIEso0Gni3Uyai
QO/5JAqznAaoQs56eJVnkh3YobnERfMO4qVC+5ZSeAO9pthA0X4qX8HWSfvw9MuzB0fsKmeN9SSX
5J3vTezaQFOOUEmIr4TQl7hF99rQ5sK3hx3v4vkaU08aNZ/0SOdZVckzuFnXlH754j5bGfgFuxVD
8wLyEms0x6nrPaUTmtJ4jIpSwVNQ38P6V1f5ea9pzqHFmU5pX5lynqQc3iHYL/rjfOFH8GeDKN9h
A5jWaXcqHJ//cfHgkHtysDvcOTjo7ZIMjltvgbug6LRO5EVm1ZY86Qnx8HpoQM15FcBxAnBUDInU
U8DP910ByFIhF9WHMaFf/XFO+NlzTWMwc+GPKWX99jVNw0lIM+CaxF8A78xRTRKIyxtJYv4OUHRH
/FFyTdn7TA6afBpPkhRWP8wzYRMGd7LFOF+ktE32hL2NplqfIUEu4vHUjy9p0C5uQn+UbkKKZQUh
lQtSvJp4Hns08jy4y4/z0qIUtoStaqwy9IyZ7AVVaKC8UczTZDbPh2iupD2YXftpiOIfkAMzyuF1
c/oVKGrTIQGd+IuItwae9QLfpPBngxD5+YnWGZp1amjCivzBw7DvQRLCJ0Adfcp1U4PCwDKRzNeb
E2dNmQH5rDe82CIF5PCfhB7/2PL06pwbw116yUB6v3gqa3dcCXZhCrqm4Ut7xcMXE7YV0aJUq+kA
m3Bln7C+GY3omKnu+fKq9oUWm1r4XF4htfRxCwVmtsTdV21/AJgtVyklZKdNTril4xbb/dEtAW56
k6RX2dyH7Rsn8iJBA5JSpnknvy+S3M/aen9v2+SUPf9tkdkiysN5pPSVMW1NnKQzP+IdoMaAPxkS
btPgNoyFdXenSZJRsgPC5tst4hI/zm5oivW4wST7Iq0mCdm591s61l1h1ekKyzRC3t6PzFocGqWS
MGDT4WjLGtx4TdCXuW7wnlsMfX9vrSBHrTFIQ9tUFIZHlIgeARZhOsIem5MIiQ+seYD752F8mRlU
KKxXLZQoijg1mmatNntwXmRp8bH/qaLBx/4nXl/lhSUAiXuyGEXhmOwdnZJpkuWw4dyqVtL21u2D
IhJEibODUzKmac6YMdfdE8e0MOrA43xnzRy+A08M46kfxu05nTl1437sfzKGnafhtZ9T74rePnZY
aHpFb8WgGlGJSiUJsZAPy1Wf9Ej7WU3hs7ZGeB84ps2rgwaIwDYScMfonaNElKmdI25AjpK07I+y
JFpwpWHVGP8m/+xorzzl+RaD2ivboRC3SvVyN576oHemaaYpABSrFQuMLac0gkp68l6DWvLV+oXZ
WLrlpEWAtCzdnpy/PdjfHR4P9t/vH/WcaZ7Ps61Omc7wrPLzZBaOh0zNrcoiTK3NhBDU5KP0AUYI
Seqntw1CUOkPHBpFqmYQpkg0+Iu1BuDv77kVC9lokKK9YtNQ1bbTFipVAI7bNpS7DEGAhivrz9BW
9I+1nnArCGcNZuBYymfXxJuc8XGLMgmEcqimM1gtoyY/rCQwTMATdh0z5ro0TNKhP8ponFdhmBHD
E+LRYmjTBIipKt79/pU4a7qXlAKv6toyWeB1Kk9ISueRP6ZkEXOIUMzfIqIVCi0o3g6TCXrQqAIx
c0i4J/7NFXG5Ww7Jk8V8TtPm2kaLPLjoJyPM+CyCrShi5HRFb5Ga4L50c0W8d8T9krsgW7GSK3rr
EHdtA7gH0Pgdvis/f55RGsPbe4uZmG9uc3lxbZM8kP7RHq+I1Z70ZL0X2xxmxrYfQFgTAHVmNPdB
kdjOs2v9pQVtE4eiYs10hGuCYt+2qXzNxlM683vO2guHXzP5LVFwO9Gb0JiUbScdxl+9QKv9/fdA
MQfaN80EHiYgYWU2VAZHX8nKnoPZBJkMFG9yG9ggbdXMgrHrcj8SfNF49fkU6gmhFlR1Kk0wqyHe
mLjfLba+u9z6zneXQe52t7pbb7pdbvpX2YMBc9GsBuLkJqZpNg3naBgAz4NhxpUqij4FRP8mV2cW
iBC6gi9NWPRFBurYJMmJl8DvyzRZzNUPc5rOSPd1t0u+tDSdZ6sWp3j7XwamvElNKjcSUqtWjMaK
HkillYXCUtxSgYu43iIOc1sx/8P6rGdMEXfAOJnNI8pFjkJ7bKJ7mbLaPoKNJrdNRXUx1OO11MuG
1YUZoZ7mIDAWBMevxs+Bh7q1OK3VeKnaLo1DVai6jN4fr+rS1Fz1Cy61T8LkDFfdDm6NIsgE2aoI
MsYG47tKZRBnUdqpqcHDTo5faAp6r5ZqGlw1HmvB96uggNUG44fXfiCYsHms1SJZ2GFrKF4+JnRy
ijCXRmVTqR+U/WRzftzIzAr5FPwaGV59fjd/VKNR7WJwE2l08NLOXbimp3SJjMExyp5kNjiuCmFi
0wEj0ksQ8JjiZDhPKYiYPRcVQi7hnjzDK9iB4gcT+BrFmwMf4xtemnb9GE1Z5XSL1w1pla/Qngq/
LiPoPh4OW4dl1ZmXh7MyRAqpaKbXJREdtGy695WzpLrqQaRasZjdKAKbrQjbaH0pDfTv6qRFeIRs
6qOKDieKr5PET6n5kM2vGFbp7P6eNJmMWSW8cWCsxa36ncr2gCJF6LdHW5ePkk8Rbu5gpMKqfrLJ
nqJc8B9ZX53NvvRT0K0qhEityXDjKXi5woy3mEBWMz88kdkdtQum+n8OLv5EWf0/EaCX0cNKciZn
croLhHX8TpvX9RS+VmgNLIjm9RG53ITN41Izlpd2qWyiirMrMRPhElbmD7KkxB6KEtt+Ry8ZImRm
056kZj5Ft+Z0pABe1YHOhYrmmnhePGIAp1FcGI1nojqkqa20h2atuwJhxigW7qg9MiBnLHtN8A1s
nbo2QjFz1p+HxjP8xVo/jMFVXrVTqXT3WhEzmi+vjhu9qEROskBTJ8JrJRcOkJyJuMeZqoJampJ9
F5gRnaL/fIEfVSrpubLQ1Qq5Zsxtt2s8nKGJfAoEHCyZap91zjcOzlX6zui6Ax1GXmaFUOO0ZXS0
FPMRvSVb+Pr5LYN+6vO7npCZhTW2pDehFRVrot/Rf/oJApFol4y/bTTkPeBvChttKJL63zTZrFEI
xX9bUzxXG2wjnLB98Lc1fV80ODY+hnHwtzUV36LkDKfyNwNtGDpFMvLXBiM3lHmENNmBHJTYPfmW
e2nXci/9g9w3VMNyMD8qHi8D4rrSyAisjpSYRkSGSWoWl87CwKVQuPL7+caD23LUCtvM9OVnE2Yu
hKgYKtdoMVMBm6ZTwZRxRTCk8uJVnL+ASwSDjQMQVJbXalHl0b7h6NedzdJ154VD5NVF7j2bEKAC
/OfMUTnMCs28wq2rhxDVl40g3jBAuMl0ii5pYUSvpRLNAOMp2VWennhIBDKiURJfZvAiAGY58KC6
TrIET0F+ffdvxWsGvNbL3qB6Bvsj1eU48O6Z52i9mqv+vB7IdgH5cHZ2gosN0nLW5t0JIwzDl1w8
eMA4Bi6HAMyQx8kY+uMZ1RfQfPwoXmLTkj6GBOEEjc6YxgxcZNzCSoQ986STEseQJw28GHnW4QXX
1TeF8sTC39rGyfxW3whoVMH2gSTuTfns9gLVbMo7nUZa7GULDOBYNw57gMryJH3EG8by7acz8CXa
hZptJ7Upy3aFIUnVq2a00waPXe0Qr2+sHEZa0+KQX96YnVeqllKFnh33KAsy9YatmOttaq5NXHqt
EtEU+qpSvVsuNd3XL19WN9Y17+YVgLcVcm31pEvXdU1/r0rRK8yf2SjqF57KCWh9G3I8B1/u7WX3
lpXvLNvqa7FeUBijrXgb0KRHoGaOVyk6l99DyrL3EqFffx1Rhf4KrFpGKAnfJnYrJiLka6Zx+HPE
ZGNW1XeaQiVmAH9/v/RCYXth9wkET+NTEjhWhHZh1xzLk96csDFkm7NyRx4+wlzBXs12RWRGCQHN
wTBMnKIqu61VPAuDfvQQaRD9d09a+JfEL5unQHH6gHna1M8KvwPB/oQSwlqqmEEQd431PryhI1nR
rVCuWsYTN/PCrgLQCpbhX2w9E2Vq245dfVMBuxiJsxfYqhoSHZsGTzph6FWFzk49O3HjlGaosl+s
YYVOZ9KKLp2RCRFLxyUp3EA5TWM/im7xITUGMb+QonThx67hLzGFCtgtB+IBBnXiwBQ3Xx4qhkdc
EY4EJeeS5TDyZwW5afTdguFzIMCF4n27Cv/GJVcjwrWRbyqGPrpJE7u54+pXtrJpP9TK1m51ZYVW
XU5Zym7sZs+nPgoxiKHGKeRbHcdSr+iSMwXFDAbeIlfSYlu6FQH2OqX+txW726Z1sUoPi7xWlYYf
Yw6aXkjo5cCe88RVSdG1aHNEcTECez5QEDiqToTpg5bxG+4mDGZ7W53OxuabdrfdbW9srWnDWFnQ
N0xHKpChU/Y2ydEH4Stn4CYuHS3UiFVNaS8GQqEM72i8KViDplkos9ylMbXqbtVga5U911JGZXg2
S3crPsKIarWx2yrlYyJ8xYdhNoT4WtmYiZi1seIcgmFZzS2veEvUBfBy1GiE9QOJIF9OaSwh28Jd
d5SkAt9KjEBTAZQvst7a36XnY8Ww5UNKWkXmqT8nHun/tn8GisGI+vFiPhz7ccCYmPQ/GKI5h7AX
raRxZRmMqOan+MDKQhZqoVSZSQfxJzkaZUEx65Vg0LaYEx8JUozXmwqx0V/kyczPwzFGio2Z2xPE
9gC14M/fb7LlAwtG1Dbki8ypuTqoQWi/jewqlkCPJCiioY0u1qrGMhs86S0nXZUXv+P4BAJl76yg
tokTCOSXh/E4J3J50biCn+pZnqgLL/joChAKrCp3toKjtWN6w974bCoVO6fjGknHWiqPRmtTFEMe
8dxb7OnAp7MkhoiIiR/8KVyI+zEVOP1XsgDJb+lyivYQ92nFJdGooQ5tQt3uh/lwkqTf1r12QtfX
bjmqdpDFXPRyA/cM6ayUXfCQwXGZhxCbYLDSsBjT0fNwY3heBpHhQDDMpsmNR9M0ScFOLYljOs49
8M1PFjl5QTxv5n/F3+QVccqSBLr+T6kf5dM/1OwIf/WQIH7emiOyl6qI+umQBY8RZKaoUjXeO4eo
HIzBMumGb03Bgicm/1AYqsFO0RkTg+SLsUWs/IronE9UEzx+9nXlgSbDw1si5TqwnSbiZG/g7pr0
LJYad293Tj8MT4/PB7v9z92LB/RyZnqKA3RD52PoTJNHLOODFZDotjZq84bdSNrVKhU2Ha4xXJ4u
0JbdPqIafVIbUvAkmD0/GmR5h4fs9QN/nkPIi2n5ZmxiwWwD3LoOMcJoTnFil+/aCbegvuT/zvgE
GKxLBpX6mbPJUvjq57xNstt4zC6NGu6UN90l8aRlygchq/HH3s/ncZhfNPZoNk7DOeyN3oDVZNf6
dDGHNVUCyDO8ZWREJxBVyI9vCb5BpI23+KWHPE8Oo0qRvvXrSHxtfObeoheNs9s57SUxhRO1MUD/
7h3YyhBerndLs0b/Kx2fwmnSw1BLkIMI8xTM0wSVwfB3OgYKr8NsKSI/y33ROGNcDAc4pePexma3
cX7oZ1e9bvfNm8Znfpu6aPzqxzkN3t720L0VrfDb2sM0PITJOE8x8clIxpoo9uCyWOBrvIciJrgj
dQI/f0tzUczWsqANDB+uUwZPiJP16oipgYtTX6VYXFi73SQOQiS35//RAiopE3jaETFbvgA8BE21
VFSUMMUrqZ2FWh+lmfrqD42GcjEYooHb0I+KSMRcLAgD3huSH4EPPabxc9b0kOsd7MObQ5QV1qa+
IlZxWthxVU0ow7At4gSYS/vfDbD8BfPfZ1y6Z/2xQvgufC6hD359xkE68zRBquxc0TSmUSf14yCZ
4VjDEGzK4ZEi5fVgxA4eOxX3dc3yYXMTPBOMloWvEIPw4kLTXemShBIHOijhQ7WUMksqDxLCe1at
zcumkqUO60wkzSPVHEJzDDIB9WYQ1mqeT8lGhRtJqzQb6SGij0donPNTfOmof41TUhUmJGSKfUnV
Qq8ktRWvP6uTBCsptylLHjuxdqjyucSUBhmRrEMRz4S4YelXN8h8jdUUpZu1EW4T6rGDWzfWYXZH
NVfTn+09KhHzl3fGr7JVfdmMiKq60m5vVf1FSb4iYPJ6XtWVeNy3dLdW2arg1Nyv1c7A1hj7qu+F
MTUu7S3hrVU9CTZfmoTruVVt5GW6MJd+XUGTHecZHo9CUrVTLQrEFXultLdUwVdcn9SAKiVFxCO3
e8XpIHrYUHVb+uMAcyIRbMiifjLJZMO2wAV6BXqqUVyua0elUa+mXEOvgXl86rJcwf80fsqq3lUt
wbZmdrUKWYDHucytwegDnMYiaeWEMBcZ6Mpry7JS6gZ+ZbBthn4l8iGkQuzTxlFfdmuWSQg2KuwA
R5ELBP0i6HiR0iHy+CGoP/xLusxPqTgweBIU/QtCp7FaQ9Wrl5VhZJZneLAN+RWrUvcvntG49x7K
8oVrN6UpAYsjwrtRFAcigVqvnGBNWy3Mo/ZmaR41/h4g06m9MewoIU0JUxHBCKH6rgYh7uElDQNg
osRNLoEpMEvglII3LsazC34Upo9SI6smW8S54NtNlWyxXOqQ9klsL24LfSUxUsNxIcTIBBehebKQ
SdgLBQ1Uu8jilXUFNrDiK0yt9LV0rprjl61ilQgnS1eT2bF6vdyO9wJxOAgFk64PWyZLM6BUKZ7J
1EKQT5YI2MsEaiuI3P5VxtyqZMEInf101h6k/hoeCl7kzG5tWswBKwDtskCCPJdhJRGL0BwV3FcI
ti3Oj6rqcaG1hfyqshJIoq3CwLaqmowgoQUBZa7WK3njsht6lOQlTi39Zv9N/tlUcqbdy6RoLVFz
afCRzprVAVwIRcYVjduJcLQ/yg7YKQBXQ3is7o8tkKGC+T8EzcMBw0y/MzJJkxmGnJRG9JzVQRRm
ytJAqLo7godRT38jh4ryKbzg77WP7GtoRqsdMcR6IjzhJ4J2n1RDyPsRPqYg6ybBAk8nPIK0m6V4
h0vm4nUM38ymcIGYwEaGSQjg+ZHBVWjanq6wNbQaSRbFxnOi1UerqG046FbVaz3aJvRcRj1idpiS
RXA7EImpdFZvfSk8BKpegleg6VoT7SIAStm0hxvTmj2YPEW98hs6AlC8mIGsNOsyfn/QvilmpeUn
cWHHqthnKdO29qO/klQNZRqmqfdMJZmrdiQJx+2qY6ryjREkUj9gkvTSJ3WljGUVNAxnmihm4T1E
sKNWYS+zqSSiv7/HHW70ypXSeqd4y9Q4zRI5UsqDRcegYPdGKOUy1fOyIax2Q6s1XfI6z5i08RrO
UCXai2f27bo3dvEkj+FHB8cHB293dj8OT3ZOTzW9GzvyxDnFNz8XDGi0Iibr6WQJcm22U9JQakQv
w3iZodTjfHW+xXpkmUVYlf2X3d7QCH2CGbtktmkRJr866arCSq0Vi3zuurdflRKyV/YuqkvqWmfd
aG2qJXxdZsho7UEkhK22VbQ2U1PF6vdza/Vy4lgrLKXUsUtqWZPHEmJX0dfMo8cZItr0VRgQMku/
h0YDZJmqXbMk3a81cZKZIkm9Del1to3snK4IraXaIj40GlxZIOIn2WM/6t4TSraEFTxPhWU59wht
12Y3KlwiueZFXlBZ2A0uI4kgJswXdUn2pJqhq8cNg1o3TF3NZUSJUZDlWPyINWQW4UAKrHpra3qs
TenFqTv2cN2UYisiBW6Ms5pVRU+0OQDocxCevaMw1gNJiFRP6ldLyhbdGVW8HHUh91jZy10+GgW8
UvfbgVgBLqYKUMJEyAFXSpqlwaUVmQFJXr6s7nZp0izbfO1VG4qnlq3CSl3V9bJCB/hMMIeUJ5Uz
NpIoqTM0ixpEBiCsqCGjEXqoQRUxc151yd0Deb5y+4ne/vVL2V7p0fPIF6TTyu6KHGSrVFySSeyb
uzBygf2J+ZpWpupVkjfV7k+zdmEss4S6FqHa8yK00BBUqSCbVxVkUzQpUcpL0WQpciwHkui/bUkB
U+u6v6LEzKJ7eQMW4Kvwh34/OD4/0XskKhbUyNZ6WVctExyZ/4rCkf5LsGd5fUBjvCEmdx+CcolL
GXXvQIfH50dnMlqdEVhAKWRIZ+ZhRsRpmyGhYjQINyEaeDM6A/Ein80nmTAXfIyBYOPzIczrovHr
1M97rJtfpzSlPfNVh1kQshrHCE7WY+lHIQ/sAsyrpOP6aX+wfql+waVbj5Psxp+vx0lAr+HHIgzW
4wQos7G6BaBcED6FVZfEDCFoLErZ6f6blkVcwfFa9l3IzfhimsPzjJfEURhTPhu4rnkMwV++fN0M
AMltpLLCRLC6imnamYUQbrdxntFUX4jGe3jCMJai0Y+vwzSJZzTO34GPMVo8KquNGvas813YpvG1
ahu6yFIUHWh8Tb7IxBNC/AOW8WCKFo0BZWZ1SYwm74uUik9gCrqZFdahyRy+/NjNGh/DKDoNL2M/
6p3uvz/rDw4bBxBm4LB/eHC8+7EXxpMwDvPbxs5sBCfGrj/3R2EU5iHNers7J8P9k90h1GzIktu3
yQI156c016scJUf05iQNr8OIXtKMXZJOWAqAPQpY1r+dzebidwIe37uwG/UvSZynSYS4z7SSD8mM
Gh9YKgjt40c0QzlILjPL58MkWETUVnK2QOWWXsTySPdYjN3GgPrBr0D0J5jXrXPtp8j1lAUjpb0P
ywWtd4IgpVn2zp+FESB6591w/6h/Rvi/r+GP86P932SDI0hCjblpGEji+wA8I0IxaQbhrh9FmAYL
gF4A+ccYhkk1FH6MpbB+KeAhIoxIj7V5YpQzyeAWpRAXVcyi2KR+dpUd+l97EBzqELk2/Hr5ngO7
coAMmZbpEaH9SFWsDNOlkHNWUBrS+FpXkEVVyjHuefNCiawDWg123UbVJY0xVpi+IKJOTegdlGkZ
Zi2MptdJ5rnGtEpKcoirdrA3PNh/O9gZfMJ8Zau1UgQBMfSv/bfDvf7JwfGnQ1CcYy4jjX7Uim/3
j/Z6hm+OWs4zh6xpiUS0kUCvzmZp2aGdIMyu1OqDnUNe29i6ndSfqRW5Astel+kUtX77zEvmMQhX
mrPF+nB8PjjtvdlUS04Gx8fvhnv7797t754fnH3qbfzAd8Jjtyba7P+sUM1PP7n943euhs3904/D
/zo/PtsZvv101j/tbb7+4eWLVy9fvTaRqFbaePFyc+PNm80f1Eqn/d3zwf7ZJ0BNf/BLn9f94cUP
P7zuajUPd35jGZmOdqGC8F9QNpp4jdJN19l2UsKC8LwwYnNBOjpD5/mg8jQlrostzumKUTCNiFvV
O7SK9z3C7R697Rs1cUHEX9tCBBSRVmiajyB4GR3BZUHDI4hakCRRhGbjdZYkQLLmj2pW2gk8axUZ
rL5ANqk1i+MaA6RXlZyKeaMN+oc7Z7sfPm9cPDg2GEWuJwgBhf1pOazKo/Jp94ogcMCP+dcO5NvE
Xp4+fdZ5YG4qStxcXk218JGfSiOhdRfHrkh64F1j7LueLRuWd41Zm3q2NZAJakpT5+YDi5jpqPM0
nDUzzKOzGDU7//z8eQvljK2Li+eddeI46yRrbbNCtWxNKeRzyMgD9n2HK0V6rO+1bot/Z197xPnM
cTD3U3+WXTgwOGXg9IjDvjrbJIY0jGbTzxxBw5k/v7hgAXNE26Kx3uPMn1u6+zfp/PPL545eFd9E
Kyp/frp90cFcTJiXuwkF68TpOYA9pcGdeBmEKIQcC9lilOUpb7KxTko9eGSj1VJTS1pblpo9V5qx
hEIFLhA5DIgeceT2ws98iB5SUIvIwufPV+qMbxm9qyt62yK8pLIfsUBqb0pSVlCfqX06fLmdFqZu
fVS3glJY/l1yx5TjPdb5Nsup9vw5X7Ryl0A10F+eRMkNTZvQbwtfW/kH2Jgt6Hfmz+c0KHqe+fOi
Y/a/mPJJGUgiHLM/AVFxxMnfMF01NdSG0hoGAEg2WjwlCoOA1wARWKvWhWmwFHKsEd/s68qGfiY2
NNRriTRUSIH4RaIJe2eljiNn6CqcreXYTTwL1nbH//yuoxy4T4izJla7Ki8eBiTklTrIxp91Os+s
n9vtqgLM8mcJnvHrzuBo/+j9FgYkHSW5ABg1qN9lRi55JWvJNnP2Yxa2xRsSOy61MPxtmaS5ODQc
GUBDOQsQYeLAOdg/6sPrnTyyHKWQhyTtFciDcx1ND4YgIQxlUFMtFlRVWFNDIGQiCbMvfgvP/6rD
7c7uYd+MmSp+kn/+m3TaNzSKvKs4uYk7EArVG0/h6T2+pB25GwizCjVh2ZbF3HplyCPVZSSJlUKe
dBfVs5BOtzOP/FCpAPvgy9oiDcmTfxPnn50vX2qAUgjOu3j+ZQ25Bl+Vl92X23IT8JCfQx5U9n3/
jNyRgMa3xI8itVqe3g5ZhgsGRA+6UfiCRJeGEDbii+4GERkRv6wBt/myBpImhYfqNFS7eUr6cVC3
NMbl2PCyqRgUx9SGLBJDPyUDOklpNiVJHN0aIXUvaUxTzLCth9Vl1ow+mYZgPxWK6HrtxlNyjDbf
wpYig6NuHC3QVh6N51hK3vEiA/n5D8jdDcY4P3SZSUm2Di+gtyw1cLuBQdpKgXj1a3iY8zC2ErpG
sRwZyF+2PYTGDfxuAjgGvdcOPNufwu4UtRyyTHZjUtjRAFjSJh4hzOyvR5prXTx+4JJGU3LnCNbL
Kr/QKou/vv9etpO56GPyQ3fbaP3yEa0/b21dbJW7eLVKFwx4lp7aQSwQx+zoNTRS2ivNV6JFEPK4
wVSPrHU1mW3pCMu5GXSP4ZvhPGa9sp/wW+xVZkjV4/+udYnzJVYMbJvaiPVbFCQcNtymkB/p11xl
FWyuIBpwODYlHDKsfo/0j37ZHxwffXasVOpcqCDOU3odJotMzEAY0YFw8CXW+PMX7TT+AsfxNkgM
RjXBvZ11CVPrT+1VgNwqY/kBxbVmgadier0CGiEyLcOTKUyxbkVr9qskEk2I813mrGvYlDTqONti
ibvKuoq0doqgiANC1ZalWylvsZQu4HO4Shjy6nj2QmTRUnVBjMspzWSh+C2KMWqtLIRfRQYcXlcm
7lvbxOgpSnBntyZuPDrgi4Bi6thL+hO1azpk4Vw0IGXIRW0oHuCdB+sqZowWc9bDxZ5wxzKXpd3I
eVj70abAAmXrE2DfmIebUOtMk+RqKI2oIFQfONloFMGzvHEBlxFGYXYFD5TclECxxVJFSEzEZNWR
eDB6VlvYCeg8Sm4daWtQE0NIi+KnuWZpVU1zfmdNn6ERp+/778sGSPwlXOnWGkSwcO1Sauo+W98t
zK6El5ZrmxUPpl809y3NzUbNJmn+8BRj7JPvSbe7udlid79Wy6iLthQmdYSZ0F4qESgm6qKhyn74
4fj4o6rOshYXm8cSb0Lk5bK1lM5rwnWNd6MHIrXklLZ1VuiHxUwZmeGE+SwNdax1NpiFi12Enj6R
MWGselqPLhrscQTed7NRGG+Jl94t/nMUxo3Pn8mXtf75/h7x6O/seu58Wbsb9I/6v/b3xH1vy3tg
6FgzLoKu6hbcbaBJyo9L3Ee51+gNedHtkh9RQmaP1chlahxUAFjni548qNSQRwZXmj3G94XPg1Pc
lzWZepfRmPigVdYowjXWwi0aVbVAzp5FQzXvvYnnQiUNuuHtb+t1CEqdUs+Kztner4zeV+FVwPX3
DPGSwDlXrfeFB5dVlXVzmKo00hC/zo8DoW4GxYjiG7L58/cbq+hSCuXJthZNlClJuIblxmcG+Jyc
hLbEAFTTmqBbxBNSf9KJcLPihn0nn4atG174ilXzNnPEgntuk4dV0ME4EYHGyokKxyuFY9wX7s7S
2JmrnPwJ3ZLZmKzwaWipZH+1MCaLKMB1YGzRAvNjYCh5DIELyo3AXxusF9LVwOHtjZaF7k0oIAIJ
Mo89hj6RSmhF9e2Q3fJh+61g/GRJt2qcINacJZUve+yK39Dv7A3LJbxh3qpLOoXtRoXGgkUlKY/0
8uUL4FXl4bQC6GxTqtyWQGBlqubjlLUa45LGYxWriTfA0os5F5o7C64Hw5cR9r/taT7j0DMr2OHM
/zocJcHtMAv/oOTF5oyV+kEwnFI/oCnZZYb93inEqgjzW+8kicLxLXG4gtHL0jFx4ySm7jYZ+Rn1
QJsnPogYo1gJQjCCm0USqx8IJPXYgs/pzOP+IaL5JPVn1APjW1CLZcZ3deRwdqn2OYqS0ZboWViR
alDMaBD6pSbbPNO61jezw1Prujd+NvMY1/HotR9ptTw/z9OidX4bUa0xbxeirZ67TcByD+IFKdDx
rebxGFpoZJt5cBi4bBx3m2hlwvoym1M4mSHCHutWFMRJLhOYZ0YZWklPaOqN/fGUGoXjqZ97DFus
wCF+dOPfZmVSSZMs847T8DKMveM5qDoltcBN3EuwaLX2A8pSYT2uB4Sfm8YRJ0487o5aUX9AJzRN
FTDjxEv5t8pGv3liT4BdpMdNVaFtFoeTSU27d0i2ssFe/+iTXpupdqkqRqpyq7DmwNf07YauJ++R
jj8PO9cbHRErgOXLUNTn2puAP59HnB46YNm+bWrZN7td4t45PMzulpNcOesO9r0fOFuO1ZDCeXCt
Snx8YeDg8cPIE9uyA0EJfW9ycfdi8+HLmqMAPE+Tr7fDuZ9lVkOPbaMi8vdrlgWTbLQ3zPKM5mIx
wCaSsLeDmlq/eWBG6O2fEHhgmCWQUCMI0toW75L0xk8DGsBf5MsaqwJ08BW8aVkZ/LViL2BjmTBt
bzVqm39n75Wd+5tO6+/aa83dy+76D90HwH7z71ud+7XW/8PwEgxbWzC+BDMCHDBGVFN9Z5FPkzT8
gy0Sb+WrH2sa77JjE1o6jllvtACnO3xsnUzMQvEOsKSSHwxl2O9u105YuF8fzz3YuyJO9+uQUxSX
Nlginyc9uxGW+qS4+RpYzxjSIm455yfvBzt7/eGg/1/n+4P+HjAZ5SXx/5FwLQlXLPZKJGNSxE32
rfTgp5f/7Zb/fH6Z+gEVm3fBfq64bXlt5/9S8qp5xDdf/vF/O6RjXlEgNqDNzr4ZhCnes6qSda/o
0mu9n2qJDytup7Wqu4YwC9F9oKvi8NSmeFeAXTVbIYuOo+WFLEIBIyToxjqJAXu1EyknISzM9zFg
YZ7YveE3RFCnIbfo33SIjIfAQ3ihMb94hVS+vlS+cmX/q8JJ3Jb2sOesvVa70ovelIuKMBw/1DoG
SNW2ufxqvIY1ZaYNI69Zb82YdeNk0P9l//j8tKhhoqCh2qQbxv+yNSvT8FSMrSTCUwBQk70XUGh1
rSgsVRbRPdYq0NrQ/A1M9wOhEOmVVCQNoQTpldQiDa706JlaEMNbD4gSKJLoRFqKsvwPjDvagKdC
pZUWUcAIk6TsUbNEDTlwmqM+MjTjqGhBB0BdiepL0AHgrqwBV4Rz+gePoFsOF2pERZfBkhSQi2/2
ZHmYVFULJKEb8wk4V3SuZQ9bpYwoEgoR5m0lsNAwFWJL+GEMWSE5myu42VPCs0lKrGdkBoe26J6I
5MeYzbxN9vOMQK6YOCdN4fjS4vFtsD9RH5YFWCJmV8/9K0QIBCzMpuGcTMI0y8k4SjKaCVYMvo4k
mZBi/bBDJetGMmER66Y0ioifZeElOkhmxE+p0Oe0H+vHjE7MLKKkV46XZXgv66WVQe9tS8YiZ756
5a5GRwWukhQfbg2ylyZ3dSCKkKWeEcPHuiPrs0HyEEY+SenlIvJTzED9mBAgYwgn4qw1F0z4yFoO
CcU7+uH+0ftfn90fnn46fdYi29vkKTk6e3fK5k1ni4iJQWM/xjBKVGRgx7WDs0YEl33WWrIoljSN
zTAg3qK1xf64bG297nbrcVG7NmSbyV8088elLK+rw4Xk8toMtPooSBQC4IxZJmQC9zR8j2rqjI8X
lLkfL2hp0PwqQtoq3EYd/6HRKOKFcVZbEbTZRqTqUIp9W1imTDUL+urhn58yTsLeebg1cO90d6P7
Y3fV4NA94vo8nX2pYFS/dBAAyI9FLm41XBhOQ5NkDGe7BiG6nODogoKjtJcyg7MmrUSVYik3OGvS
yccoBtmBlYKfjxpD3pYdFyzIbcIUPLdavm95a82arNyknE63Vbhf2TrUg7gaWZfZSq3ajCdCfswq
ijyXLEsbm4OSH+WRMxURxq3w2qFSB16ewRdBswu0ztqdtQCMRyyNirB1dxVF9oaH/bMd5DHyZdMW
oOzOFP3RhMWSbhbDS1vhZhG1bcUyFYZh3LU6pFqkSFzpChCWkubK7b6BNqXVaok4K8GWqEEAzEVY
MX00MAakPRMAPfBwXaRka0jmSmBtkFahduW1loFK8UjV0o7/ZzRXv35JOp/6MS1WjyeAnNHch0O3
XXhOyFCieIuT6TzYEcWsS/Ss7+jgvzM8OQbHTuYpZpa+ZaVw4yuiui7vf+Sq/fmocGw8JW+TfIon
HMjwILOLSwLhgkCbHNFrkVmA0BB9NyD1C80ynlMALgAsPjWL2d9u2BJFV0RGwKj8Q7CEAka1ueXh
Dn4ALUcCQbBCIFkQT9HhTnbAmGbPdcHWHP6B7Hzw75g9lcKfKc0WUQ5/QfdDUL7KHzzJsysPAjNg
uT0FmE2gBiwrhlQF3GjXWQSpnSY3dTFqiefxpre9HRZCHElO+Xy6GJW+HfphfALWhcUn/lpsfB0g
NtQvEKIGmu+CkGr5foo4KtmfskXff3fac3uAZD+AFGrFGknLXn69gBLlYqHMrSWW0VnDlg7cM8Qk
W7iySom4mLAJt9iKqy2LebckGZTbMzy0BHWoHagIaSlEU+7EQJFGU2ZtfusAU1zy008/QXhzSSJS
bmKIYFQVxuwXT5udLUbse0D9gH+boXMvNyvGL3zC1bbG4k5YbLj6lNsMPzyKxGIM+50PJREjN0Hx
mb+tV0LBMlqL3YJKK3sUeDu7qN+tegoALa4UGJpwjkb4CIUQWL+rjXSLybx2F0swTsTRKuAIQmba
hl1wjILVKdNk21imnCi3aazqmSciv6ZpOAlpwHgq0qSS1708e4H9UjTs5axaiFmroW/lJStSWKmL
p6k0qoLoqsSsZqDorZQMfnnOeD2acOXWUXDExROWF6kUoJ1ZRq5ESbslrKiktJx69D1f061JR9B9
B+/iGO9ZIaZ5SgMKBJykmHjAT3NBUNbk6quFRWqY1v/fHMHIIdaASrbJsxQcQjJGWykajyn38IY3
4DDXLmePZRlLc70yUnCVwHVa3Dq3wXNlVEatryYAW+B/BQvME1djlDJ3jci+JNgH5jqXXASi1Uc+
I76n5NBPr4RWGPAmbHHHfhRtEV/kPoefZObf8hGm/jXFhFgLcGeEdiyHc/sv3+7aln1MEHF1T9dZ
PNfsazXO/bJVJStwALb1pKFzZYqDii3IQydtPuKZGeuIMIZSLQVtCsR96O8cnH3Y8sCKgbu2wJ+6
/q16WiM6TmaUTCHk3fTWGoOb57ZnrzKQQql52t89Pto7Jc/Jj12MlALhZvGNFXIh4JCel4URbA3P
A3nco2mapMTzhFWvfPYnnjfzv+Jv8oo49vhLHQbfH47qJcHdmPAw+OtGxgc4beAieO+EFLj4uSdR
1GppupQViI982zpxV7ksonSueaHJFDWcTzN/fj2Sl3iEhUcxRqFTPxDqOf3pHYBZzNnLO1QSxqTs
1V38Kqq9YtXwJs8e2ZnKW1Z4A9N+TB6aHGyw2QO7KNeDh4mv5Sw1K+41UU1BQqXswUIJT84Y8DqW
6kAvZVapQoHapjyCqopRFIXaihqsV7HcKFVclqpHzHPVbD1yfhWzM5LGMZQXuY8qcK5CYlCcJV9S
BRhmwLlyVzbYkHhXAkwlc6f0hmKDSLcv0NrLowacxcK8bjOvEv/SMG95Kb8UVi13r1C3zMcT2/fu
tdQVVXAP19V4h4u1XZN98FqSeYhqxhIorEPUUNFSsuiRxkMajUkNK7OvEe7KyszUBUX9c7mQD28Y
auSUY4jMmel/mAk9s3aBqhrMmsPjTzUbqbTDWPWFUPBO1f4MWIxOMVW5HUsqbLOZY1wgzOQ8RF+9
ni0NoNmnmgxQcepX+6lMEjjQdPLGRYW9H6VJFAEBclu14rps3qQeG1nSKc2llA2uCk5RYxmsMA6H
VdCmhvHapxnj4Fs2WRkVs1jhv3SKzDBYOKyUUtauap9Rx0vKJ3hJLmrOrnI6m5csTPV+nVanLTyj
WIHHemj/hv+J/Gd8w03KHShswSwx1gmSOsytQFTIE0Rn4ciquLiiGKAuGZVLsfwhGPAm0/5wWqw2
pTFFmgNTbDADzOnyq+ZLb7RsOQ1jHjUdr35XFO/dFTMsGZwtd4JV5ZeyWF1FZWaKMUllogsbmSlE
VhuGVyGklaQnYhzygpCYdk6/BlRNSDUIkpPhuS1rZ7KKmZd9bvVyGFGFEjEjjaAqx3isRRmjlD/9
avTNtu31Y6mm7kqUbSMynkx/5FSpEEuzfKzwoadFXXLa2C+PPMWqhFoPgw33JkhzVRJe7MhWgH9i
Y51sSIh7a9uDllTnf8ltuXx1tVytypvhG9RpgkmyywsZy/gDI5ZnjWeeUxRO2U2Yj6dDptEUVwGh
DbTdv/UJmyeVCFSht7WjxWB06uGgA2WyghWF/uqdiBpWq8aPiWe7x4eH+2eatg9g4Sl/GY8sKSsq
gJbBJFSElA3IFc62Wq9l6UurWokVu9LKpq/QdDQ2KtY1ClaqVi72/1+QOGJAJfIVubGy7b9xs5ac
iZ4o6XX/j0E+T+2Ntwd+EQWraUZy24r5lVgkNl99QZ5UpBv+3xVPYh0xYLsVcj3N9DejlfX4CGT+
Z2T70GjMUwquFsJKeohBxyHcVr25wtLXQiGDiwBM89t8msQvzAdR93HZTtzVX0GhOgu/wjKg8vi9
7BHUH+fi4c/D2GKjJMkzyCuLqOXAEm+faN4Oaoqw0772m+el++kn9+QT5P4d7LzHiJwf3QbLC0gu
07n4M8kaCAwYs0fhiPDPkIxJVJnfBOJPWDP5920GeS8mAr/NcRIHIWzBdTKjWeZf0taWOPuAJ8ry
rSJ2hB9mlAxY6sI+vNo0RdNGg/vd9BAYMPZq++nl9eeNi1ZDDMmqtMMMblVJtECze1xjVpDSLImu
4WOvx7+tE/cctWM61lmh2+Kj4hYkok07gp/NYlz42T4d7p/u7Q+aSot2lqODnQqELFiEAUYSXAcl
Xmlo5X6QJDnzPyr8Y9xibKhkGRKCFSbdzc2K3uc0nYEt4SLmjkMQM8yfUbfVQPIUUyUd4iJ52+cK
RQIb+mSxRMM3fCmwLeK306DYD26rgUgBEmtf0nx+E/uzYqU3L1rt+Q3grXGJ1S7TOVS7TLVqLy5a
7ct0eBkGYvEmUDnJ2smcxk2x7EnWPh4O9o6PDj6Re/Zrb3/Q3z07HsgPR8fvjg8Ojn9tNQB3rJ8j
eGDL01tGtdAlDYaSNpOsPUF0yKFbqtK12dQaAMog2SApfQ3jBJFmUhPWNr5B3YplHk/9+JIGLgOC
Z85w27g4CgfDWIY87TOG84SJvpPm3XK23Cv7SscodCvx+etAIG930N85Ez/6v+0emFhdJ93kdbe7
DmQ9nAQ9A2U6NGfiCOOx4SEtICaWzpBPFPBBBHUIwgRmaDS8jDtxEosrNkCaCeMJgB3j5sVodJun
ixgja6GZDbrktRVv9TBJ2ZRxddmUTbjXySSJouRGxtTvIQ5bSmwcYw8N+u+b2LfBKcSnGNVZEBt7
XcmjLQxDcKU5n0jSIIx95AzmaLI3znHgH22US/b9kn8X0MEhakIHDIstWgkcRnjokiXdsWZhhtpa
BaqV6UeQSfH76C0cW3X0klK2k9SdyAcs46UpasuNpX4odqDAANt74hffdXYshJBE1Nh94USQc0Gs
ACT6YQoo12F11mEpWkalWRIUlXANWiJKwlXNhAG5wX9GuVaqZcPqZFt80+j21EKufiwplsArVUQ9
bAJKMFcftujVoN+ioI6ATUAVCj5dmXAlyRS9ITUUPyW5IMJlBfnLxqRXpZIyJjDgHhcejuiNlSPQ
2TxX2QHSx208Lm8IWWLsqEkY+1FxthnCT1HjT6SxpjqmxKL5USL7EadpxQnJWX3gWuHQF9P4JqGo
JYryuPlUHRU7jW6laCz4I19FEDc0foFe4/oayq/K+hmyPlyo8H0UX2fZpW1F+wHDauCFQ5IoEK+y
dy/RXuDxdgT4JClHlyFG5fNho3AuEsNxJzH2J0SqV0rspm7idjpbZDlZZJSHMzWdTf/DJ1Hx9MBN
Z7l/lpKscxGK66IIrmf3fArI+b7xnGm69xILquAZBZIK4V37MUCoz+TlbjkGVFX3qkCbT7WsC49b
RxSq0mUIL9z8dHRzffo3I5xHfRDksYhFGovoVo0XYXlZlk8DIqSOovATfqeGMQhqQ7gRTlN6qRUm
wkUQD57XVjEm198Z8PUB3Z4qNCOKIkd5NSl2CeqWl4SFWGbR21OVRRmN0KNXapT+lSzS2I80jVKV
24kKWsXQxwd7wMZOTgx74ArTdzvmAMGVprpKE4Feq7FV/aKUaNlm8aI9DDzS7losEQEcsq4x7ioL
ebtdeil73Jo/JWdTCmy98Db0M1w3SMDH70uFwwhifzHflg4WmKsK1AmgrOIho9jSl3wxdGttAaa0
2JYWb4LGI/82WQiHRj2UV/9sV+q+DopcGapOTOUQzp8e6UYxq/r/LciEiRS9s9WjwaDu+5JCZFpy
CWnhyxpE1f4ZaRHr+UEAdta40KU228JAGbvHSCMlTWV11HsCZ3aqDeB5IOSXQPO8aTKjHiDCmjEe
DMEhao7MH9GJkyi5xFQrGjSqUbUZIKeS4sQrXQXRlYPU2PqxVlyh5/8wiA/rQMfCVhm9Nsoquu52
K6pw61VwiVqoDw83gqqH6PJUn1ihnLGYWX9CyyFPfSlHXsxhgNTDUkdU8mflbOJaTXb9q+yojcWF
8SsEvu/pwZWhNq/MmZmUL2QasXkIt1Y/wJyimmkA619hCvxDheRTzF0zCCt9VerCC1Opqj/Tud15
PPPTK6p6BzL0QKcs0BQqm1AbPYL8hGFGlINI8x4pMm4KCblqlnpaHyU4kKhRFxToXKqwTaDZlR5n
lPLgOCxUIJOXZecN6YaLxdxzsiqn9l13/c2PD8ucKjnaOAXw6DDKUXGwbBX5emlmbTO9kYiQYvRT
1cSfmS3Ky89085bFZ6JskhbEjMxTHVrtVvWQEQZSoqUtjxSekEUFkyDOt757zwlCVhJzqeFckO+o
6m4o4h6VI45xhYxqkoheNUU+wF7F3QOzGClsgTEM2O+9UngCb04OEj8QQQaEUTNwFodsKocif79t
KWc56xPnz/60BdErj3ee0dQcyoZFif9SD+9RMljSBT80qvoAf/5TjHBh7eeZssTPatcOGhV3Tn3V
5qEd5UUIB31ozShnDpL9E0jyZUt4hqXIITaANwCDeLZW2ncT4nRAmO5A/Q79SiWa1G1QPTnmq4ki
c8UUheuX4S/PKajwO0VePS7RveHVXE01FSiz0ihDTLPb+rvOH+1ACNdUuGvzi4emIMCbjKB1RLD4
8aQH0HuTZBEXtF9HJtLmchFjiuK2W9yZsox4UR5/IG6TZHg375GtjR/e/PCGtFxyL8NuDGuHwYbS
o1eekH6cqGFc5LiqsUZGc4+77dYgl9tUpMKoooLz8mqePN62Ceh22QFcyH4glmEbi1D230UcI2A6
nKR+evtIwQyy4oAsForIJDCNpVIqpxa5cGHmcU2i54EjeC5WT6OTnZgs4sRO/xycMOO+K38dVYow
smEMdyo5zlOyE6B6kaXFChYpchx+4+cRiMIsifAVVsuoJTQFYxb+Isvhxi8XpKdYduNigS2htNlu
mKmy5XmK2tWfIZSy6MnZ5tcMiKmsfy/ouvjaYO54Z/rXJZuBaFkqk9Jx6F1arpwz8gYhqtmIf0qv
XC2gdN1JmblY8YGHtGkQIO3eGr6LZFlE6Hjup/6MePj0P0/DGd189fp6g0AucdgFGp8hRTPizRcj
8JH2kkUOyZXIXn9g1IZ8Ta9fEu+mS4BDEfd5xyWuN3TZTy8gbg+fVb6J1/G4Bl66iOX+AhfuCDSO
xPNqd7oaYskBsadn4l4pR6GmZ67EFzwUlXoHkJr+sH8Izym9MJ6EMZzJaiSp2QgSVez6c38URiGG
pdrdORnun+ziG4zsMgM1y3XPOYCclG8HO4NPQ8xuaQiVxZZAfQaLAeqYvahmapgs7hCMwDFupuAv
trpv94/2eoUnGmMsJoBKfWtIbsdetzCXK5NxzRCDnUO9laB0a20ecNRsIII71Y3TPz0+H+yKtlVI
d6x4OxkcH78b7u2/e7e/e35w9qm3scnHcqqXz3ItgKtUsxn2utvhT6+72+Hz5xAzoLg08XgGcYKJ
Eoj7zCXeJDtVIxa8KDsU4jLygAV2xRoZpdS/2q4IHPBNgrMmNpcEY2Z9yU+zeeVxxmwvfycOAjAP
g3VH105Ky8eKWRMzCqxxqDhrV/RWmEHKJw1pAwkJqqNwtE4g/8g6cJ91AlheJ4s0isJRmyc6kb8x
qAQzlgSA2uMkuYIAery/03A2j+gufhRjpFRYSGbzJM7ABBWKm6l/w/NmZPB6fBnGuqVkmOFBEo/h
3fcyjOFtfZy3TLvJU1y0/tcwbypyAGQNgvsDz6UhxsaHRT8C1i4fv7NxMqfBepFa/fPFOvl8Ubj2
kh6J/Nko8Fn0uS0VMvyyTrI8ZcYgKW1DxC18AWymrpFV6sWDu846aakv3exiAxZY/g3IKgpmitnO
/TRDewMVx82WUd6GuwKgtiiAjpltwixJMwrPzqJymNNZ1lRQKtCPJnM94g6HkHCFBw3yAgqM1dWr
o6kc+pqsk2wxmYRfAV+Iy3XiulpdvOJA5218TAHngGnTOojntlYYRiwddgmJXq4hSvgk/FrZaalP
Tmy40E3WsWXkR5Ibo3AGno3kCnxktDwYvMWG8YI2KuFkC9lmlFTu4PGQ1sDIvYv8+RxC/DRVSmoL
6mdok+qEiMZNtjQt8jPZALkZPjGikJ9gOrwaq4Gl37S9BRcCTa0/G4WXi2SRie2Nj7W4c9hgn7sX
eNNgI8MS8LE/dy+KGSAvQHsrUfZ54wIug6K/zxsX/wGsxI9C8AfkxvCFGZQrr1+nOFCSurBhkQMW
42W8DLYalHy2NLto2Gmcl7fEGhRLIKe2qcxUtTL9T7aBYVumk/5TchxBAqVkMgnHoR9Jhp2RBAJO
YMgvMWdYFZH1cQTRZTku20p3b3n84TCFS+bCj8gpzT3GNCETEKrwixCJBPzKbpI08GAKcvS2krgL
ZUqObrC/brrs2766YTRMs/KWhllGQ6zkm/HKgSlZ66FuQg7VvSDP4S5CnqvDr6ur3IDLzDphifnW
meXHOpkvRlE4xiS6PVJ4HGxd4DEOIdaa8CC7TiAL7jrhJ1UPTrJ1Mvbn+SIVhzw3dtuSVmbgGd8z
hIv2gP3bBGgAZpH1EkBnI4F40g4Ws3nWhEFbbRpDeNBma13i8M5l2QbdLTkfV0066m4R18y45q4T
9zePXTG8XUy4570FJLhbAhnPnjX5BGEd7x5aD62ydTicY+akFmmEdr5SguLxt3obm90W8TNJZAYZ
sCC6PTZldprzii3zQNBxbTkHGEWwLtcLquYTAioewmq6xd5wQfRpNSp7UY3RVZGw/eHs7ARt0mFq
1DRO/wjyNtpLYExwJDBWi8A6Cmt0VI8gtQNtAUfHCsjci70ILcCgH4Yc9geD44GrJkrT8RDQHFRE
Cj6zJoMY7gvNl90fX7f0+Rb6qh5vzbY7DOuua5+wI7fVgsVQhEJWhcur7ISRYp6yfEoLOWa9KIlv
ciBMwnPcj69AmpQtWzZBAhElq8gKfAGbv8D5jau2To5P8Q+jG+CL1afcROFRd7BTH7iv3BaBxSF3
DNMAxwO5w3/cFvP7QoSMp2BkEl8yKIESQb0Q+lH4B007stRdh43XAIoXnz67cHCG40WU37rIUzc2
tyw89FwauSnrOk+TZEKUDlqNOImRvXcbLPg0cHF+OWpnU3/z1evmxLlThs/8KHcvHrbusOWDIzlS
qz2lX4PwEhhaS5Nzu92u29oibKjnPbIhncjoOKV51hCHELBd9qmdJ1c0Hk7p1+bGD61G4RjCsCUP
/QxQ5HLLuEMg1C3uwbROXB9PuRPeubslD7t14kZ+fLnwL7E+jV3GTl1EkLtF7lw5431oqMxfLbhY
x8zdcDVgs3uA1cL3m0lIQUjhgH92i6/uRYNf6/CfoZDhxNyAC3QEpDg9pe0WKX6ss8CP5bkxNvOR
3sJneaY9lM6oM3xnZD/WVdHKvLFqgIo7a0McDz1y53ImukVEb8rxkqWAUi6ujbN0cgZr6148AGHr
shbv8nPRWhpEuRekkMxwSxiU0AlolqfJLaJMhJfdBb+zdIYnn7uFbkUP8uRuCXEG28EFQFxOod5W
rWQix0XbOWgT0IjmeIuwARclydViXrecDxwclvqtgAUliVWBYc9RoosGnitN99fjwcfTk53d/nD3
Q3/34/Bk5/RU6vnR0lIQKvvBp4I/XDQulxoUJgOAZkm8pWwzRs9/rv19u0gaIT5u8G+rvLmAnw42
6nVbLcXkQrxKjC2zZkpgxoFZsGSuih8yO5WanH3ViZeKVxQevodMaUq30bCcKZ/x9VIGQRst4iBC
VTazksVUi3AWoQp7mKHNL83BewhOFpEdh6b5KMkhlhaoTRVzX2YKWTwryLSPwoAYQxgPQS9X2BQz
FbD+Ef3CcXxIYWl4BRC/pDizG8HryQdLzVwX/q/Sgh6LVzdPLMX+xTkYRarbuzA9YtUlVlMa0xs/
ahDYSZQ4wsAONwDmDNVyTRUWQ8XUmKuEj0+obNl1okrpGCI2D0FLEMaXqp2ulTqKHGF1RCCcIfq/
nfR3z/p7QzNdkpHcSXxFk4PqRnaLfkEK3OCAp6HATQWubu/D/MNiBAGr85TJsQr5s3dYxUVEywwW
0xsWIRsqFJlbS3BBMU/haub+KgYwPFPsiaKMUIQQaQZWRaYcLfYXX0y+fvCmLKDtmdG9pXk1mu+b
faJDBrLPciBEZd6O+KlajmOHJXea5hxyTmd5uT9zbGfVMUYUjvCSKbnVcn1Zh1aeVGle8AjmpKRZ
hewmfDnKqn0LgDNMmlHJfyyzMPqx8cY6GGoHYk1cV7xuWs34+YGYCkrkzhTLudj5CbpnIBOr5FgF
6BgfmodPfAzvWp1T1WUtKxjOUVIOJAKnrMgnzV4COKBFPoCl2ap0xwlLMg8xWOSPr0Q+LpFSapvA
i7OvqsTYcgirCBMgNF3Un/7qU4WVwLClz30ML2WKaYWdlsf/RnYruuZld1oW6S1Pq/zwDcxZQK7X
rcxVpof9LSK7Mh5YKoCMCinNpjRAfiJGU/jqozKr/RlHRRXs//GRYXZce2hUQfEnHB5m1yseH0a+
T4Xs8DwUIZfMiRgr6hSflPEsRGZ4yEHez7fHZ/DADzYBZtw9jYrQiw8OKlBlyFyW/nhGZdi4ghFp
4VzBwFztiTuxFr6b5damAappNWV2eG/GbjS7FCEO1Rht1YdsGZc1B60NzX/KMbvaimoHrYUy/pKD
d3B8cPB2R1yg5dGrQ2w7fhex9UKqnbCM29EUfA3hZOq5caJemY6OIUDgWX+guAvibV0jGqV9EVfw
/EhsuP4AZAQ4P7e8OHnQg9RzE0NvjocWiGuU0Hic3s7h4n2juab9nXz+1IkvtohL/Di7oamal+6O
fdryPj1Aejry6f72/pZm95/6py1zhpAd7ug+vo+T+6NjvfSWZlj8rCWNK6Fb8gm040eYfFqkgCvQ
VHTA5ALsxNhX6kzhiYQgWuB5jL2lE7DiU3QB+tRhzmNFr6Rai6vf2fjYtS6Y7IFrH8C5SAv1EW+p
23sLd5qKaeEd0CwBnGo6jWoaYJ7yI0pu2YtDnLS/6ZKuZ94qW+m14Qko1QrEWVoY6SqOor7160h+
tZsQVkNUnQCqoiuG/CSVIZ5jG3O1BUiWdodH+5ic9WD/cP/sVMYZPjw+PzpjhTafGTPKdm0EaV55
W429J7+pfiy10Ue94tzoH8G89krn4bIg1qKdkSr2ibXv+3vm91QasqDYPnLhgMciRP/iuiDbZrYP
BZzVvWEFy58mydVQSuiQ9At9pDCMBaBLqxdmAitiuZSYvVzIYFaaww/Hxx8L/1hWr0PzcYcbvvJ/
VbtB747tnnWxVx7kBljWUt12qw/4jzt/fSQHaQcdGVUcTW3llgVWZe0LL/OrtVdXT/g4NDGyAfo8
m6noWo7uR8u3lTDnXoX3a0NJY3ChvbYmaNmujNxqUFFVTrptJfJqVaRRHIJf7I80BSVMRBzEYKZp
nSNn999/T+h4msh8lvgDqbaFEoiYAws5gE357UauSzGbQi7ZrroDbWMSTMLV/ZbeUR/k4a1I9st0
RMIOA8Wjpf3wAT2uo1BZY6XyQu+UjRrQUejH/Adk4BsGFJrSeBzSrMElFzEw5tTlMluL6MIbyz7L
8NEimk6YFQmVQYsYahfeMpYdm3IhVECJ5n8B0NNZTIRRAQA=
KAIGEN_LEGACY_ADAPTER_BASE64
    rm -f -- "$temporary"; die 'Cannot decode the legacy adapter.'
  fi
  if ! printf '%s  %s\n' 'bc42de34e5f0fc09dbd78a4aa3f49632cafb7b24f45aaed96a1ac8a2721986f0' "$temporary" | sha256sum -c - >/dev/null; then
    rm -f -- "$temporary"; die 'Legacy adapter identity mismatch.'
  fi
  chmod 700 "$temporary" || die 'Cannot secure the legacy adapter.'
  sync -f "$temporary" || die 'Cannot persist the legacy adapter.'
  mv -Tf "$temporary" "$destination" || die 'Cannot publish the legacy adapter.'
  sync -f "$(dirname -- "$destination")" || die 'Cannot persist adapter publication.'
  printf '%s  %s\n' 'bc42de34e5f0fc09dbd78a4aa3f49632cafb7b24f45aaed96a1ac8a2721986f0' "$destination" | sha256sum -c - >/dev/null
}

configure_auto_updates() {
  local layout=$1 state_dir timer unit
  if [[ $layout == canonical ]]; then state_dir=$STATE/updater; unit=kaigenweb-update
  else state_dir=/var/lib/kaigen-webd/updater; unit=kaigen-webd-update; fi
  mkdir -p "$state_dir"; secure_dir "$state_dir"; chmod 700 "$state_dir"
  [[ ! -L $state_dir/updater.sh ]] || die 'Unsafe updater path.'
  if [[ $SELF != "$state_dir/updater.sh" ]]; then
    install -o root -g root -m 700 "$SELF" "$state_dir/updater.new"
    mv -Tf "$state_dir/updater.new" "$state_dir/updater.sh"; sync -f "$state_dir/updater.sh"
  fi
  printf '%s\n' "$AUTO_UPDATES" > "$state_dir/automatic"; chmod 600 "$state_dir/automatic"; sync -f "$state_dir/automatic"
  cat > "/etc/systemd/system/$unit.service" <<EOF
[Unit]
Description=Kaigen Web daily stable release update
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/bin/bash --noprofile --norc -p $state_dir/updater.sh --scheduled --layout $layout
TimeoutStartSec=30min
TimeoutStopSec=120
UMask=0077
EOF
  cat > "/etc/systemd/system/$unit.timer" <<EOF
[Unit]
Description=Check Kaigen Web stable releases daily
[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true
Unit=$unit.service
[Install]
WantedBy=timers.target
EOF
  chmod 644 "/etc/systemd/system/$unit.service" "/etc/systemd/system/$unit.timer"
  systemctl daemon-reload
  if [[ $AUTO_UPDATES == y ]]; then systemctl enable --now "$unit.timer"
  else systemctl disable --now "$unit.timer" 2>/dev/null || true; fi
}

bootstrap_legacy_update_jq() (
  command -v jq >/dev/null && return
  [[ $SCHEDULED != y ]] || die 'jq is missing. Run this script once with --update --layout legacy to prepare updates.'
  local dependency audit status status_rc=0 plan pins before guard=''
  local -a packages
  for dependency in apt-get dpkg dpkg-query lslocks python3 sha256sum; do
    command -v "$dependency" >/dev/null || die 'Required command missing: %s' "$dependency"
  done
  status=$(dpkg-query -W -f='${db:Status-Status}' jq 2>/dev/null) || status_rc=$?
  ((status_rc<=1)) || die 'Cannot inspect jq package state.'
  [[ $status != installed ]] || die 'The installed jq command is missing; repair it before updating.'
  wait_package_manager
  audit=$(dpkg --audit) || die 'Cannot inspect the package manager state.'
  [[ -z $audit ]] || die 'The package manager has unfinished work; finish it before updating.'
  # Existing repository trust is retained. This first-use path never repairs or
  # upgrades the operating system, and the three admitted packages have no services.
  NEEDRESTART_MODE=l apt-get -qq -o DPkg::Lock::Timeout=120 -o APT::Update::Error-Mode=any update
  before=$(sha256sum /var/lib/dpkg/status)
  plan=$(apt-get -s --no-install-recommends --no-upgrade --no-remove install jq) || die 'Cannot prepare the jq installation.'
  pins=$(python3 -c '
import re,subprocess,sys
text=sys.stdin.read(1048577)
if len(text)>1048576: raise SystemExit("Unexpected package plan size")
allowed={"jq","libjq1","libonig5"}; install={}; configure={}
for line in text.splitlines():
    if line.startswith(("Remv ","Purg ")): raise SystemExit("Package removal refused")
    if not line.startswith(("Inst ","Conf ")): continue
    match=re.match(r"^(Inst|Conf) ([a-z0-9+.-]+(?::amd64)?) \(([0-9A-Za-z.+:~_-]+)(?: |\))",line)
    if not match: raise SystemExit("Package upgrade or unknown operation refused")
    action,package,version=match.groups()
    if package.split(":")[0] not in allowed: raise SystemExit("Unrelated package refused")
    target=install if action=="Inst" else configure
    if package in target: raise SystemExit("Duplicate package operation refused")
    target[package]=version
if "jq" not in {p.split(":")[0] for p in install} or configure!=install:
    raise SystemExit("Unexpected package configuration refused")
for package,version in sorted(install.items()):
    state=subprocess.run(["dpkg-query","-W","-f=${db:Status-Status}",package],text=True,capture_output=True)
    if state.returncode not in (0,1) or (state.returncode==0 and state.stdout not in ("not-installed","config-files")):
        raise SystemExit("Changing an existing package refused")
    print(package+"="+version)
' <<< "$plan") || die 'Installing jq would change existing or unrelated packages; no packages were installed.'
  [[ $(sha256sum /var/lib/dpkg/status) == "$before" ]] || die 'Package state changed; retry the manual update.'
  mapfile -t packages <<< "$pins"
  guard=$(mktemp -d /run/kaigenweb-jq.XXXXXX)
  trap 'rm -f -- "$guard/check" "$guard/status.sha256"; rmdir -- "$guard"' EXIT
  printf '%s\n' "$before" > "$guard/status.sha256"
  cat > "$guard/check" <<'EOF'
#!/bin/sh
set -eu
# APT invokes this under its transaction lock, before any dpkg operation.
base=${0%/*}
sha256sum -c "$base/status.sha256" >/dev/null
cat >/dev/null
EOF
  chmod 700 "$guard/check"
  NEEDRESTART_MODE=l apt-get -y -qq -o DPkg::Lock::Timeout=120 -o Dpkg::Use-Pty=0 \
    -o "DPkg::Pre-Install-Pkgs::=/bin/sh $guard/check" \
    --no-install-recommends --no-upgrade --no-remove install "${packages[@]}"
  command -v jq >/dev/null && jq --version >/dev/null || die 'jq installation did not provide a working command.'
)

require_update_dependencies() {
  local layout=$1 dependency
  for dependency in curl python3 gzip base64; do
    command -v "$dependency" >/dev/null || die 'Required command missing: %s' "$dependency"
  done
  if [[ $layout == legacy ]]; then bootstrap_legacy_update_jq
  else command -v jq >/dev/null || die 'Required command missing: jq'; fi
}

legacy_update() {
  local state=/var/lib/kaigen-webd/updater current port version latest adapter
  secure_dir /etc/kaigen-webd; secure_file /var/lib/kaigen-webd/installer-state
  current=$(readlink -f /opt/kaigen-webd/current)
  [[ $current == /opt/kaigen-webd/releases/* && -d $current && ! -L $current ]] || die 'Unmanaged legacy release pointer.'
  mkdir -p "$state"; chmod 700 "$state"; TMP="$state/cache"; mkdir -p "$TMP"; chmod 700 "$TMP"
  if [[ -f $state/automatic ]]; then secure_file "$state/automatic"; AUTO_UPDATES=$(cat "$state/automatic"); fi
  [[ $AUTO_UPDATES =~ ^(y|n)$ ]] || die 'Invalid automatic-update setting.'
  if [[ -n $AUTO_CHOICE ]]; then
    AUTO_UPDATES=$AUTO_CHOICE
    [[ $AUTO_CHOICE != n ]] || configure_auto_updates legacy
  fi
  if [[ $SCHEDULED == y && $AUTO_UPDATES != y ]]; then return; fi
  require_update_dependencies legacy
  [[ $AUTO_CHOICE != y ]] || configure_auto_updates legacy
  adapter="$state/legacy-adapter.sh"; write_legacy_adapter "$adapter"
  /bin/bash "$adapter" recover-pending
  current=$(readlink -f /opt/kaigen-webd/current)
  [[ $current == /opt/kaigen-webd/releases/* && -d $current && ! -L $current ]] || die 'Unmanaged legacy release pointer.'
  local healthy=n
  for port in 8787 8788; do
    if systemctl is-active --quiet "kaigen-webd@$([[ $port == 8787 ]] && printf a || printf b).service"; then
      version=$(curl --noproxy '*' -fsS --max-time 5 "http://127.0.0.1:$port/healthz" | jq -er '.version | select(type=="string")')
      healthy=y; break
    fi
  done
  [[ $healthy == y ]] || die 'Legacy backend is not healthy; use its installer recovery.'
  latest=$(resolve_stable_release "$version")
  if [[ $latest == NO_UPDATE ]]; then configure_auto_updates legacy; say 'NO_UPDATE installed=%s layout=legacy' "$version"; return; fi
  # Download/extract without canonical state or pointer mutations.
  local asset digest tag
  asset=$(jq -cer '[.assets[] | select(.name | test("^Kaigen-Web-Debian13-Nginx-[A-Za-z0-9._-]+\\.tar\\.gz$"))] | if length==1 then .[0] else error("Web bundle missing or ambiguous") end' "$TMP/release.json")
  digest=$(jq -er '.digest | select(test("^sha256:[a-f0-9]{64}$"))' <<< "$asset")
  tag=$(jq -er .tag_name "$TMP/release.json")
  fetch -o "$TMP/bundle.tar.gz.part" "https://github.com/$REPO/releases/download/$tag/$(jq -r .name <<< "$asset")"
  printf '%s  %s\n' "${digest#sha256:}" "$TMP/bundle.tar.gz.part" | sha256sum -c -
  mv "$TMP/bundle.tar.gz.part" "$TMP/bundle.tar.gz"; sync -f "$TMP/bundle.tar.gz"
  # Existing legacy transaction owns clean-exit, A/B, Nginx, and rollback. Its
  # isolated check uses the candidate and fresh storage before the shared writer stops.
  prepare_boot_recovery legacy
  if /bin/bash "$adapter" update --archive "$TMP/bundle.tar.gz" --archive-sha256 "${digest#sha256:}" --expected-current-release "${current##*/}" --non-interactive; then :
  else
    /bin/bash "$adapter" recover-pending
    return 1
  fi
  configure_auto_updates legacy
}

update_cli() {
  local layout='' requested=$1; shift
  [[ $EUID == 0 ]] || die 'Run --update as root.'
  SCHEDULED=n; [[ $requested != --scheduled ]] || SCHEDULED=y
  while (($#)); do
    case $1 in
      --layout) shift; layout=${1:-};;
      --auto-updates) shift; case ${1:-} in on) AUTO_CHOICE=y;; off) AUTO_CHOICE=n;; *) die 'Use --auto-updates on|off.';; esac;;
      *) die 'Unknown update option.';;
    esac
    shift
  done
  [[ -z $layout || $layout == canonical || $layout == legacy ]] || die 'Unknown layout.'
  if [[ -z $layout ]]; then
    if [[ -f $STATE/settings && -f /var/lib/kaigen-webd/installer-state ]]; then die 'Choose --layout canonical|legacy.'
    elif [[ -f $STATE/settings ]]; then layout=canonical
    elif [[ -f /var/lib/kaigen-webd/installer-state ]]; then layout=legacy
    else die 'No managed Kaigen Web installation found.'; fi
  fi
  check_system
  command -v flock >/dev/null || die 'Required command missing: flock'
  exec 8>/run/kaigenweb-ui.lock; flock -n 8 || die 'Another installer control session is open.'
  UI_LOCKED=y
  exec 9>/run/kaigenweb-install.lock; flock -n 9 || die 'Another installer is running.'
  WORKER_LOCKED=y
  if [[ $layout == legacy ]]; then legacy_update; return; fi
  load_state
  [[ $COMPLETE == y || -n $OLD_BUILD ]] || die 'Finish the installation before updating.'
  if [[ -n $AUTO_CHOICE ]]; then
    AUTO_UPDATES=$AUTO_CHOICE
    if [[ $AUTO_CHOICE == n ]]; then save_state; configure_auto_updates canonical; fi
  fi
  if [[ $SCHEDULED == y && $AUTO_UPDATES != y ]]; then return; fi
  require_update_dependencies canonical
  if [[ $AUTO_CHOICE == y ]]; then save_state; configure_auto_updates canonical; fi
  IS_WORKER=y ACTION=update
  TMP="$STATE/cache"; mkdir -p "$TMP"; chmod 700 "$TMP"
  update
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
  prepare_system_nginx
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
  configure_auto_updates canonical
  log_action 'Installation completed.'
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
  LEASE_HOURS=0
  [[ $MODE != service ]] || LEASE_HOURS=72
  ask 'Workspace deletion timer, hours (0 = disabled) [%s]: ' value "$LEASE_HOURS"
  LEASE_HOURS=${value:-$LEASE_HOURS}
  [[ $LEASE_HOURS =~ ^(0|[1-9][0-9]{0,6})$ ]] || die 'Timer must be a whole number of hours from 0 to 9999999.'
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
  ask 'Enable automatic stable updates once a day? [y/N]: ' value
  case $value in y|Y|yes|Yes|YES|д|Д|да|Да|ДА) AUTO_UPDATES=y;; *) AUTO_UPDATES=n;; esac
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
  inspect_system_nginx
  if command -v ss >/dev/null && {
    ss -ltnH '( sport = :443 or sport = :8787 or sport = :8089 or sport = :19050 )' | read -r _ ||
    { ss -ltnH '( sport = :80 )' | read -r _ && ! system_nginx_stock_listener; };
  }; then
    die 'A required port is already in use. No existing service was changed.'
  fi
  id kaigenweb >/dev/null 2>&1 && die 'The kaigenweb account already exists.'
  STAGE=0 ACTION=install STATUS=idle COMPLETE=n PUBLIC_READY=n VERSION='' BUILD='' PERSONAL='' ONION=''
  CODE_HASH=$(sha256sum < "$SELF"); CODE_HASH=${CODE_HASH%% *}
  mkdir -m 755 "$STATE"
  printf 'Kaigen Web installer state v2\n' > "$STATE/owner"
  save_state
  capture_baseline
  snapshot_system_nginx
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
  if [[ $LEASE_HOURS == 0 ]]; then say 'Workspace deletion timer: disabled.'
  else say 'Workspace deletion timer: %s hours.' "$LEASE_HOURS"; fi
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
  if [[ ${1:-} == --recover-boot || ${1:-} == --check-backend ]]; then recovery_cli "$@"; return; fi
  if [[ ${1:-} == --update || ${1:-} == --scheduled ]]; then update_cli "$@"; return; fi
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
    say '1) Update Kaigen (stable releases only)  2) Uninstall (erase all data)  3) Reinstall (erase all data)  4) Exit'
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
