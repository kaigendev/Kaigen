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
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
KAIGEN_LEGACY_ADAPTER_BASE64
    rm -f -- "$temporary"; die 'Cannot decode the legacy adapter.'
  fi
  if ! printf '%s  %s\n' '31c0197f60007f516bf5affbc29285ef9d1142d3c20750b76c9d3cb653eb88fd' "$temporary" | sha256sum -c - >/dev/null; then
    rm -f -- "$temporary"; die 'Legacy adapter identity mismatch.'
  fi
  chmod 700 "$temporary" || die 'Cannot secure the legacy adapter.'
  sync -f "$temporary" || die 'Cannot persist the legacy adapter.'
  mv -Tf "$temporary" "$destination" || die 'Cannot publish the legacy adapter.'
  sync -f "$(dirname -- "$destination")" || die 'Cannot persist adapter publication.'
  printf '%s  %s\n' '31c0197f60007f516bf5affbc29285ef9d1142d3c20750b76c9d3cb653eb88fd' "$destination" | sha256sum -c - >/dev/null
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
