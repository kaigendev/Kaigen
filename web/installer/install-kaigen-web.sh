#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
umask 027

readonly PROGRAM='Kaigen Web installer'
readonly MANAGED_MARKER='# Managed by Kaigen Web installer.'
readonly SERVICE_USER='kaigen-webd'
readonly SERVICE_GROUP='kaigen-webd'
readonly SLOT_A_PORT='8787'
readonly SLOT_B_PORT='8788'

ACTION='install'
BUNDLE_ROOT=''
NON_INTERACTIVE=false
INSTALL_ROOT="${KAIGEN_INSTALL_ROOT:-}"
TEST_MODE="${KAIGEN_INSTALL_TEST:-0}"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }
root_path() { printf '%s%s' "$INSTALL_ROOT" "$1"; }
require_command() { command -v "$1" >/dev/null 2>&1 || fail "Required command is missing: $1"; }

usage() {
  cat <<'EOF'
Usage: install-kaigen-web.sh [install|update|rollback|uninstall] --bundle DIR [--non-interactive]

The bundle must contain release-id, manifest.sha256, payload/bin/kaigen-webd,
payload/lib/Kaigen/libtoxcore.so.2.23.0, payload/TorExpertBundle and
payload/ui/index.html with payload/ui/kaigen-build-id.
Non-interactive install reads KAIGEN_INSTALL_MODE (personal|service),
KAIGEN_INSTALL_HOSTNAME, KAIGEN_INSTALL_TLS_CERT and KAIGEN_INSTALL_TLS_KEY.
EOF
}

while (($#)); do
  case "$1" in
    install|update|rollback|uninstall) ACTION="$1" ;;
    --bundle) shift; (($#)) || fail '--bundle requires a directory'; BUNDLE_ROOT="$1" ;;
    --non-interactive) NON_INTERACTIVE=true ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
  shift
done

if [[ "$TEST_MODE" != '1' ]]; then
  [[ $EUID -eq 0 ]] || fail 'Run as root.'
  [[ -z "$INSTALL_ROOT" ]] || fail 'KAIGEN_INSTALL_ROOT is test-only.'
fi

readonly ETC_DIR="$(root_path /etc/kaigen-webd)"
readonly SLOT_DIR="$ETC_DIR/slots"
readonly STATE_FILE="$(root_path /var/lib/kaigen-webd/installer-state)"
readonly DATA_DIR="$(root_path /var/lib/kaigen-webd)"
readonly INSTALL_DIR="$(root_path /opt/kaigen-webd)"
readonly RELEASES_DIR="$(root_path /opt/kaigen-webd/releases)"
readonly CURRENT_LINK="$(root_path /opt/kaigen-webd/current)"
readonly NGINX_AVAILABLE="$(root_path /etc/nginx/sites-available/kaigen-web)"
readonly NGINX_ENABLED="$(root_path /etc/nginx/sites-enabled/kaigen-web)"
readonly NGINX_UPSTREAM="$(root_path /etc/nginx/kaigen-webd-upstream.conf)"
readonly SERVICE_UNIT="$(root_path /etc/systemd/system/kaigen-webd@.service)"
readonly LIMITS_DIR="$(root_path /etc/systemd/system/kaigen-webd@.service.d)"
readonly LIMITS_FILE="$LIMITS_DIR/limits.conf"
readonly MOUNT_UNIT="$(root_path '/etc/systemd/system/run-kaigen\x2dwebd.mount')"

check_debian() {
  local os_release
  os_release="$(root_path /etc/os-release)"
  [[ -f "$os_release" ]] || fail 'Debian os-release is missing.'
  # shellcheck disable=SC1090
  . "$os_release"
  [[ "${ID:-}" == 'debian' && "${VERSION_ID:-}" == '13' ]] || fail 'Debian 13 is required.'
}

check_live_dependencies() {
  [[ "$TEST_MODE" == '1' ]] && return
  for command_name in nginx systemctl curl sha256sum install mktemp mountpoint ss; do
    require_command "$command_name"
  done
  if systemctl is-active --quiet apache2.service; then
    fail 'Apache is active. The installer requires an Nginx-only request path and will not modify Apache.'
  fi
}

validate_bundle() {
  [[ -n "$BUNDLE_ROOT" ]] || fail '--bundle is required for install and update.'
  BUNDLE_ROOT="$(cd -- "$BUNDLE_ROOT" && pwd -P)"
  [[ -f "$BUNDLE_ROOT/release-id" ]] || fail 'Bundle release-id is missing.'
  [[ -f "$BUNDLE_ROOT/manifest.sha256" ]] || fail 'Bundle manifest is missing.'
  [[ -f "$BUNDLE_ROOT/payload/bin/kaigen-webd" ]] || fail 'Bundle backend is missing.'
  [[ -f "$BUNDLE_ROOT/payload/lib/Kaigen/libtoxcore.so.2.23.0" ]] || fail 'Bundle toxcore runtime is missing.'
  [[ -f "$BUNDLE_ROOT/payload/TorExpertBundle/tor/tor" ]] || fail 'Bundle Tor runtime is missing.'
  [[ -f "$BUNDLE_ROOT/payload/TorExpertBundle/tor/pluggable_transports/lyrebird" ]] || fail 'Bundle obfs4 transport is missing.'
  [[ -f "$BUNDLE_ROOT/payload/TorExpertBundle/tor/pluggable_transports/conjure-client" ]] || fail 'Bundle Conjure transport is missing.'
  [[ -f "$BUNDLE_ROOT/payload/TorExpertBundle/tor/pluggable_transports/pt_config.json" ]] || fail 'Bundle pluggable-transport configuration is missing.'
  [[ -f "$BUNDLE_ROOT/payload/TorExpertBundle/data/geoip" ]] || fail 'Bundle Tor GeoIP database is missing.'
  [[ -f "$BUNDLE_ROOT/payload/TorExpertBundle/data/geoip6" ]] || fail 'Bundle Tor GeoIPv6 database is missing.'
  [[ -f "$BUNDLE_ROOT/payload/ui/index.html" ]] || fail 'Bundle UI is missing.'
  [[ -f "$BUNDLE_ROOT/payload/ui/kaigen-build-id" ]] || fail 'Bundle UI build identity is missing.'
  if find "$BUNDLE_ROOT" -type l -print -quit | grep -q .; then
    fail 'Bundle must not contain symlinks.'
  fi
  if find "$BUNDLE_ROOT" ! -type d ! -type f -print -quit | grep -q .; then
    fail 'Bundle contains an unsupported filesystem object.'
  fi
  RELEASE_ID="$(tr -d '\r\n' < "$BUNDLE_ROOT/release-id")"
  [[ "$RELEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]] || fail 'Bundle release-id is invalid.'
  local ui_build_id
  ui_build_id="$(cat -- "$BUNDLE_ROOT/payload/ui/kaigen-build-id")"
  [[ "$ui_build_id" == "$RELEASE_ID" ]] || fail 'Bundle UI build identity does not match release-id.'
  local -a listed_paths=()
  while IFS=' ' read -r digest relative_path; do
    relative_path="${relative_path#\*}"
    [[ "$digest" =~ ^[A-Fa-f0-9]{64}$ ]] || fail 'Bundle manifest contains an invalid digest.'
    [[ "$relative_path" =~ ^[A-Za-z0-9._/-]+$ && "$relative_path" != /* && "$relative_path" != *'..'* && "$relative_path" != *'\\'* ]] || fail 'Bundle manifest contains an unsafe path.'
    [[ -f "$BUNDLE_ROOT/$relative_path" ]] || fail 'Bundle manifest references a missing file.'
    listed_paths+=("$relative_path")
  done < "$BUNDLE_ROOT/manifest.sha256"
  local listed_set actual_set
  listed_set="$(printf '%s\n' "${listed_paths[@]}" | LC_ALL=C sort -u)"
  actual_set="$(cd -- "$BUNDLE_ROOT" && find . -type f ! -name manifest.sha256 -printf '%P\n' | LC_ALL=C sort -u)"
  [[ "$listed_set" == "$actual_set" ]] || fail 'Bundle manifest is not an exact file inventory.'
  (cd -- "$BUNDLE_ROOT" && sha256sum --check --strict manifest.sha256 >/dev/null) || fail 'Bundle manifest verification failed.'
}

prompt_value() {
  local variable_name="$1" prompt_text="$2" default_value="${3:-}" value
  value="${!variable_name:-}"
  if [[ -z "$value" && "$NON_INTERACTIVE" == false ]]; then
    if [[ -n "$default_value" ]]; then
      read -r -p "$prompt_text [$default_value]: " value
      value="${value:-$default_value}"
    else
      read -r -p "$prompt_text: " value
    fi
  fi
  [[ -n "$value" ]] || fail "$variable_name is required."
  printf -v "$variable_name" '%s' "$value"
}

select_mode() {
  INSTALL_MODE="${KAIGEN_INSTALL_MODE:-}"
  if [[ -z "$INSTALL_MODE" && "$NON_INTERACTIVE" == false ]]; then
    note 'Installation mode:'
    note '  A. Personal: exactly one workspace; no configured resource quotas.'
    note '  B. Service: multiple workspaces with normal quotas and service limits.'
    read -r -p 'Choose A or B: ' answer
    case "$answer" in
      A|a) INSTALL_MODE='personal' ;;
      B|b) INSTALL_MODE='service' ;;
      *) fail 'Choose A or B.' ;;
    esac
  fi
  [[ "$INSTALL_MODE" == 'personal' || "$INSTALL_MODE" == 'service' ]] || fail 'KAIGEN_INSTALL_MODE must be personal or service.'
}

collect_site_settings() {
  INSTALL_HOSTNAME="${KAIGEN_INSTALL_HOSTNAME:-}"
  INSTALL_TLS_CERT="${KAIGEN_INSTALL_TLS_CERT:-}"
  INSTALL_TLS_KEY="${KAIGEN_INSTALL_TLS_KEY:-}"
  prompt_value INSTALL_HOSTNAME 'Public DNS hostname'
  prompt_value INSTALL_TLS_CERT 'Existing TLS certificate path' "/etc/letsencrypt/live/$INSTALL_HOSTNAME/fullchain.pem"
  prompt_value INSTALL_TLS_KEY 'Existing TLS private-key path' "/etc/letsencrypt/live/$INSTALL_HOSTNAME/privkey.pem"
  [[ "$INSTALL_HOSTNAME" =~ ^[A-Za-z0-9.-]+$ && "$INSTALL_HOSTNAME" != .* && "$INSTALL_HOSTNAME" != *. ]] || fail 'Hostname is invalid.'
  [[ "$INSTALL_TLS_CERT" == /* && "$INSTALL_TLS_KEY" == /* ]] || fail 'TLS paths must be absolute.'
  [[ "$INSTALL_TLS_CERT" =~ ^/[A-Za-z0-9_./-]+$ && "$INSTALL_TLS_KEY" =~ ^/[A-Za-z0-9_./-]+$ ]] || fail 'TLS paths contain unsupported characters.'
  [[ -f "$(root_path "$INSTALL_TLS_CERT")" ]] || fail 'TLS certificate does not exist.'
  [[ -f "$(root_path "$INSTALL_TLS_KEY")" ]] || fail 'TLS private key does not exist.'
  PUBLIC_ORIGIN="https://$INSTALL_HOSTNAME"
}

atomic_write() {
  local target="$1" mode="$2" temporary
  mkdir -p -- "$(dirname -- "$target")"
  temporary="$(mktemp "$(dirname -- "$target")/.kaigen-write.XXXXXX")"
  cat > "$temporary"
  chmod "$mode" "$temporary"
  mv -fT -- "$temporary" "$target"
}

require_managed_or_absent() {
  local target="$1"
  [[ ! -e "$target" ]] && return
  grep -Fqx "$MANAGED_MARKER" "$target" || fail "Refusing to replace unmanaged file: $target"
}

install_release() {
  local target="$RELEASES_DIR/$RELEASE_ID"
  if [[ -e "$target" ]]; then
    [[ -f "$target/.manifest.sha256" ]] || fail 'Existing release directory is unmanaged.'
    cmp -s "$BUNDLE_ROOT/manifest.sha256" "$target/.manifest.sha256" || fail 'Existing release id has different content.'
    return
  fi
  mkdir -p -- "$RELEASES_DIR"
  local staging="$RELEASES_DIR/.staging-$RELEASE_ID-$$"
  [[ ! -e "$staging" ]] || fail 'Release staging path already exists.'
  if [[ "$TEST_MODE" == '1' ]]; then
    mkdir -p -- "$staging/bin" "$staging/lib/Kaigen"
  else
    mkdir -m 0755 -- "$staging"
    install -d -m 0750 -- "$staging/bin" "$staging/lib/Kaigen"
  fi
  install -m 0750 -- "$BUNDLE_ROOT/payload/bin/kaigen-webd" "$staging/bin/kaigen-webd"
  install -m 0644 -- "$BUNDLE_ROOT/payload/lib/Kaigen/libtoxcore.so.2.23.0" "$staging/lib/Kaigen/libtoxcore.so.2.23.0"
  ln -s -- libtoxcore.so.2.23.0 "$staging/lib/Kaigen/libtoxcore.so.2"
  ln -s -- libtoxcore.so.2 "$staging/lib/Kaigen/libtoxcore.so"
  cp -a -- "$BUNDLE_ROOT/payload/TorExpertBundle" "$staging/TorExpertBundle"
  find "$staging/TorExpertBundle" -type d -exec chmod 0750 {} +
  find "$staging/TorExpertBundle" -type f -exec chmod 0640 {} +
  chmod 0750 -- \
    "$staging/TorExpertBundle/tor/tor" \
    "$staging/TorExpertBundle/tor/pluggable_transports/lyrebird" \
    "$staging/TorExpertBundle/tor/pluggable_transports/conjure-client"
  cp -a -- "$BUNDLE_ROOT/payload/ui" "$staging/ui"
  find "$staging/ui" -type d -exec chmod 0755 {} +
  find "$staging/ui" -type f -exec chmod 0644 {} +
  install -m 0644 -- "$BUNDLE_ROOT/manifest.sha256" "$staging/.manifest.sha256"
  mv -- "$staging" "$target"
  if [[ "$TEST_MODE" != '1' ]]; then
    chown -R root:"$SERVICE_GROUP" "$target"
    chmod 0755 -- "$target"
    chmod 0750 -- "$target/bin" "$target/lib" "$target/lib/Kaigen"
  fi
}

write_mount_unit() {
  require_managed_or_absent "$MOUNT_UNIT"
  atomic_write "$MOUNT_UNIT" 0644 <<EOF
$MANAGED_MARKER
[Unit]
Description=Kaigen Web locked-memory tmpfs
Before=kaigen-webd@a.service kaigen-webd@b.service

[Mount]
What=tmpfs
Where=/run/kaigen-webd
Type=tmpfs
Options=mode=0700,uid=$SERVICE_USER,gid=$SERVICE_GROUP,noswap,nodev,nosuid,noexec

[Install]
WantedBy=multi-user.target
EOF
}

write_service_unit() {
  require_managed_or_absent "$SERVICE_UNIT"
  atomic_write "$SERVICE_UNIT" 0644 <<EOF
$MANAGED_MARKER
[Unit]
Description=Kaigen Web backend slot %i
After=network-online.target run-kaigen\\x2dwebd.mount
Requires=run-kaigen\\x2dwebd.mount

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
EnvironmentFile=/etc/kaigen-webd/slots/%i.env
ExecStart=/usr/bin/env \${KAIGEN_RELEASE_ROOT}/bin/kaigen-webd
Restart=on-failure
RestartSec=2s
TimeoutStopSec=90s
KillSignal=SIGTERM
LimitMEMLOCK=infinity
AmbientCapabilities=CAP_IPC_LOCK
CapabilityBoundingSet=CAP_IPC_LOCK
NoNewPrivileges=true
PrivateDevices=true
PrivateTmp=true
ProtectClock=true
ProtectControlGroups=true
ProtectHome=true
ProtectHostname=true
ProtectKernelLogs=true
ProtectKernelModules=true
ProtectKernelTunables=true
ProtectSystem=strict
ReadWritePaths=/var/lib/kaigen-webd /run/kaigen-webd
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
RestrictRealtime=true
SystemCallArchitectures=native
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
  mkdir -p -- "$LIMITS_DIR"
  if [[ "$INSTALL_MODE" == 'service' ]]; then
    atomic_write "$LIMITS_FILE" 0644 <<EOF
$MANAGED_MARKER
[Service]
TasksMax=256
MemoryMax=4G
EOF
  else
    if [[ -e "$LIMITS_FILE" ]]; then
      require_managed_or_absent "$LIMITS_FILE"
      rm -f -- "$LIMITS_FILE"
    fi
  fi
}

write_slot_env() {
  local slot="$1" release_id="$2" port="$3" target="$SLOT_DIR/$slot.env"
  mkdir -p -- "$SLOT_DIR"
  atomic_write "$target" 0640 <<EOF
KAIGEN_RELEASE_ROOT=/opt/kaigen-webd/releases/$release_id
LD_LIBRARY_PATH=/opt/kaigen-webd/releases/$release_id/lib/Kaigen
KAIGEN_WEB_DEPLOYMENT_MODE=$INSTALL_MODE
KAIGEN_WEB_BIND=127.0.0.1:$port
KAIGEN_WEB_ORIGIN=$PUBLIC_ORIGIN
KAIGEN_WEB_DATA_ROOT=/var/lib/kaigen-webd/disk
KAIGEN_WEB_RAM_ROOT=/run/kaigen-webd/ram
KAIGEN_WEB_ACTIVE_ROOT=/run/kaigen-webd/active
KAIGEN_WEB_RESOURCE_ROOT=/opt/kaigen-webd/releases/$release_id
KAIGEN_WEB_LEASE_HOURS=24
KAIGEN_WEB_PROOF_DIFFICULTY=18
EOF
  if [[ "$INSTALL_MODE" == 'service' ]]; then
    cat >> "$target" <<'EOF'
KAIGEN_WEB_DISK_QUOTA_BYTES=268435456
KAIGEN_WEB_RAM_QUOTA_BYTES=134217728
KAIGEN_WEB_SECURITY_RESERVE_BYTES=8388608
KAIGEN_WEB_MAX_INSTANCES=8
EOF
  fi
}

write_upstream() {
  local port="$1" build_id="$2" target="${3:-$NGINX_UPSTREAM}"
  if [[ "$target" == "$NGINX_UPSTREAM" ]]; then
    require_managed_or_absent "$target"
  fi
  atomic_write "$target" 0644 <<EOF
$MANAGED_MARKER
set \$kaigen_web_backend http://127.0.0.1:$port;
set \$kaigen_web_build_id $build_id;
EOF
}

write_nginx_site() {
  require_managed_or_absent "$NGINX_AVAILABLE"
  atomic_write "$NGINX_AVAILABLE" 0644 <<EOF
$MANAGED_MARKER
server {
    listen 80;
    listen [::]:80;
    server_name $INSTALL_HOSTNAME;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name $INSTALL_HOSTNAME;
    ssl_certificate $INSTALL_TLS_CERT;
    ssl_certificate_key $INSTALL_TLS_KEY;
    root /opt/kaigen-webd/current/ui;
    index index.html;
    client_max_body_size 32m;
    add_header Content-Security-Policy "default-src 'none'; base-uri 'none'; connect-src 'self'; font-src 'self' data:; form-action 'none'; frame-ancestors 'none'; frame-src 'none'; img-src 'self' blob: data:; manifest-src 'self'; media-src 'self' blob:; object-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; worker-src 'self'; require-trusted-types-for 'script'; trusted-types kaigen-spellcheck-worker" always;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;
    add_header Cache-Control "no-store" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    include /etc/nginx/kaigen-webd-upstream.conf;

    location = /api/v1/build-identity {
        default_type application/json;
        return 200 '{"status":"ok","buildId":"\$kaigen_web_build_id"}';
    }
    location /api/ {
        default_type application/json;
        if (\$http_x_kaigen_client_build != \$kaigen_web_build_id) { return 426 '{"code":"UPGRADE_REQUIRED"}'; }
        proxy_pass \$kaigen_web_backend;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 300s;
        proxy_request_buffering off;
    }
    location /ws {
        default_type application/json;
        if (\$arg_build != \$kaigen_web_build_id) { return 426 '{"code":"UPGRADE_REQUIRED"}'; }
        proxy_pass \$kaigen_web_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 300s;
    }
    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
EOF
  mkdir -p -- "$(dirname -- "$NGINX_ENABLED")"
  if [[ "$TEST_MODE" == '1' ]]; then
    atomic_write "$NGINX_ENABLED" 0644 <<EOF
$MANAGED_MARKER
../sites-available/kaigen-web
EOF
    return
  fi
  if [[ -e "$NGINX_ENABLED" && ! -L "$NGINX_ENABLED" ]]; then
    fail 'Refusing to replace a non-symlink Nginx enabled-site entry.'
  fi
  ln -sfn -- ../sites-available/kaigen-web "$NGINX_ENABLED"
}

write_state() {
  local active_slot="$1" current_release="$2" previous_release="$3" previous_mode="$4"
  atomic_write "$STATE_FILE" 0600 <<EOF
$MANAGED_MARKER
ACTIVE_SLOT=$active_slot
CURRENT_RELEASE=$current_release
PREVIOUS_RELEASE=$previous_release
INSTALL_MODE=$INSTALL_MODE
PREVIOUS_MODE=$previous_mode
PUBLIC_ORIGIN=$PUBLIC_ORIGIN
HOSTNAME=$INSTALL_HOSTNAME
TLS_CERT=$INSTALL_TLS_CERT
TLS_KEY=$INSTALL_TLS_KEY
EOF
}

load_state() {
  [[ -f "$STATE_FILE" ]] || fail 'Kaigen Web installer state is missing.'
  require_managed_or_absent "$STATE_FILE"
  # shellcheck disable=SC1090
  . "$STATE_FILE"
  [[ "$ACTIVE_SLOT" == 'a' || "$ACTIVE_SLOT" == 'b' ]] || fail 'Installer state has an invalid active slot.'
  INSTALL_MODE="$INSTALL_MODE"
  PUBLIC_ORIGIN="$PUBLIC_ORIGIN"
  INSTALL_HOSTNAME="$HOSTNAME"
  INSTALL_TLS_CERT="$TLS_CERT"
  INSTALL_TLS_KEY="$TLS_KEY"
}

slot_port() { [[ "$1" == 'a' ]] && printf '%s' "$SLOT_A_PORT" || printf '%s' "$SLOT_B_PORT"; }
other_slot() { [[ "$1" == 'a' ]] && printf 'b' || printf 'a'; }

stop_candidate_backend() {
  local slot="$1"
  [[ "$TEST_MODE" == '1' ]] && return
  systemctl disable --now "kaigen-webd@$slot.service" >/dev/null 2>&1 || true
}

start_candidate_backend() {
  local slot="$1" release_id="$2"
  grep -Fqx -- "KAIGEN_RELEASE_ROOT=/opt/kaigen-webd/releases/$release_id" "$SLOT_DIR/$slot.env" || fail 'Candidate slot does not reference the explicit release.'
  [[ "$TEST_MODE" == '1' ]] && return
  systemctl daemon-reload
  systemctl enable --now 'run-kaigen\x2dwebd.mount'
  stop_candidate_backend "$slot"
  if ! systemctl enable --now "kaigen-webd@$slot.service"; then
    stop_candidate_backend "$slot"
    fail 'Candidate backend did not start.'
  fi
}

wait_for_candidate_backend() {
  local slot="$1" port="$2"
  if [[ "$TEST_MODE" == '1' ]]; then
    [[ "${KAIGEN_INSTALL_TEST_CANDIDATE_HEALTH:-pass}" == 'pass' ]] || fail 'Candidate backend did not become healthy.'
    return
  fi
  local deadline=$((SECONDS + 90))
  until curl --fail --silent --show-error "http://127.0.0.1:$port/healthz" >/dev/null &&
        curl --fail --silent --show-error "http://127.0.0.1:$port/readyz" >/dev/null; do
    if ((SECONDS >= deadline)); then
      stop_candidate_backend "$slot"
      fail 'Candidate backend did not become healthy.'
    fi
    sleep 1
  done
}

restore_release_routes() {
  local previous_link="$1" had_upstream="$2" upstream_backup="$3"
  rm -f -- "$CURRENT_LINK.new" "$NGINX_UPSTREAM.new"
  if [[ -n "$previous_link" ]]; then
    ln -sfn -- "$previous_link" "$CURRENT_LINK.restore"
    mv -fT -- "$CURRENT_LINK.restore" "$CURRENT_LINK"
  else
    rm -f -- "$CURRENT_LINK"
  fi
  if [[ "$had_upstream" == 'true' ]]; then
    mv -fT -- "$upstream_backup" "$NGINX_UPSTREAM"
  else
    rm -f -- "$NGINX_UPSTREAM" "$upstream_backup"
  fi
}

commit_release_routes() {
  local slot="$1" release_id="$2" port="$3"
  if [[ "$TEST_MODE" == '1' ]]; then
    atomic_write "$CURRENT_LINK.test-target" 0644 <<EOF
$release_id
EOF
    write_upstream "$port" "$release_id"
    return
  fi

  local previous_link='' had_upstream='false' upstream_backup
  if [[ -L "$CURRENT_LINK" ]]; then
    previous_link="$(readlink -- "$CURRENT_LINK")"
  elif [[ -e "$CURRENT_LINK" ]]; then
    stop_candidate_backend "$slot"
    fail 'Current release target is not a symlink.'
  fi
  require_managed_or_absent "$NGINX_UPSTREAM"
  upstream_backup="$(mktemp "$(dirname -- "$NGINX_UPSTREAM")/.kaigen-upstream-backup.XXXXXX")"
  if [[ -f "$NGINX_UPSTREAM" ]]; then
    cp -p -- "$NGINX_UPSTREAM" "$upstream_backup"
    had_upstream='true'
  fi
  rm -f -- "$CURRENT_LINK.new" "$NGINX_UPSTREAM.new"
  if ! ln -s -- "releases/$release_id" "$CURRENT_LINK.new" ||
     ! write_upstream "$port" "$release_id" "$NGINX_UPSTREAM.new"; then
    rm -f -- "$CURRENT_LINK.new" "$NGINX_UPSTREAM.new" "$upstream_backup"
    stop_candidate_backend "$slot"
    fail 'Candidate release routes could not be staged.'
  fi
  if ! mv -fT -- "$CURRENT_LINK.new" "$CURRENT_LINK" ||
     ! mv -fT -- "$NGINX_UPSTREAM.new" "$NGINX_UPSTREAM"; then
    restore_release_routes "$previous_link" "$had_upstream" "$upstream_backup"
    stop_candidate_backend "$slot"
    fail 'Candidate release routes could not be switched.'
  fi
  if ! nginx -t; then
    restore_release_routes "$previous_link" "$had_upstream" "$upstream_backup"
    stop_candidate_backend "$slot"
    fail 'Candidate Nginx route validation failed; previous release restored.'
  fi
  if ! systemctl reload nginx; then
    restore_release_routes "$previous_link" "$had_upstream" "$upstream_backup"
    nginx -t && systemctl reload nginx || true
    stop_candidate_backend "$slot"
    fail 'Candidate Nginx reload failed; previous release restored.'
  fi
  rm -f -- "$upstream_backup"
}

activate_release() {
  local slot="$1" release_id="$2" port old_slot="${3:-}"
  local installed_build_id
  [[ -z "$old_slot" || "$slot" != "$old_slot" ]] || fail 'Candidate release must use the inactive slot.'
  [[ -f "$RELEASES_DIR/$release_id/ui/kaigen-build-id" ]] || fail 'Installed UI build identity is missing.'
  installed_build_id="$(cat -- "$RELEASES_DIR/$release_id/ui/kaigen-build-id")"
  [[ "$installed_build_id" == "$release_id" ]] || fail 'Installed UI build identity does not match release-id.'
  port="$(slot_port "$slot")"
  write_slot_env "$slot" "$release_id" "$port"
  start_candidate_backend "$slot" "$release_id"
  wait_for_candidate_backend "$slot" "$port"
  commit_release_routes "$slot" "$release_id" "$port"
  if [[ -n "$old_slot" && "$TEST_MODE" != '1' ]]; then
    local old_port drain_deadline
    old_port="$(slot_port "$old_slot")"
    drain_deadline=$((SECONDS + 30))
    while ss -Hnt state established "( sport = :$old_port )" | grep -q . && ((SECONDS < drain_deadline)); do
      sleep 1
    done
    systemctl disable --now "kaigen-webd@$old_slot.service"
  fi
}

prepare_layout() {
  mkdir -p -- "$ETC_DIR" "$SLOT_DIR" "$DATA_DIR/disk" "$RELEASES_DIR"
  if [[ "$TEST_MODE" != '1' ]]; then
    if ! getent group "$SERVICE_GROUP" >/dev/null; then groupadd --system "$SERVICE_GROUP"; fi
    if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
      useradd --system --gid "$SERVICE_GROUP" --home-dir /var/lib/kaigen-webd --shell /usr/sbin/nologin "$SERVICE_USER"
    fi
    chown root:root "$INSTALL_DIR" "$RELEASES_DIR"
    chmod 0755 -- "$INSTALL_DIR" "$RELEASES_DIR"
    chown -R "$SERVICE_USER:$SERVICE_GROUP" "$DATA_DIR"
  fi
}

install_action() {
  [[ ! -e "$STATE_FILE" ]] || fail 'Kaigen Web is already managed here; use update.'
  validate_bundle
  select_mode
  collect_site_settings
  prepare_layout
  install_release
  write_mount_unit
  write_service_unit
  write_nginx_site
  activate_release a "$RELEASE_ID"
  write_state a "$RELEASE_ID" '' ''
  if [[ "$TEST_MODE" != '1' ]]; then
    systemctl enable nginx
    systemctl reload nginx
  fi
  note "INSTALL_PASS mode=$INSTALL_MODE release=$RELEASE_ID slot=a"
}

update_action() {
  validate_bundle
  load_state
  local old_slot="$ACTIVE_SLOT" new_slot old_release="$CURRENT_RELEASE" old_mode="$INSTALL_MODE"
  new_slot="$(other_slot "$old_slot")"
  install_release
  write_service_unit
  write_nginx_site
  activate_release "$new_slot" "$RELEASE_ID" "$old_slot"
  write_state "$new_slot" "$RELEASE_ID" "$old_release" "$old_mode"
  note "UPDATE_PASS release=$RELEASE_ID slot=$new_slot"
}

rollback_action() {
  load_state
  [[ -n "${PREVIOUS_RELEASE:-}" ]] || fail 'No previous release is available for rollback.'
  [[ -d "$RELEASES_DIR/$PREVIOUS_RELEASE" ]] || fail 'Previous release directory is missing.'
  local old_slot="$ACTIVE_SLOT" new_slot target_release="$PREVIOUS_RELEASE" old_release="$CURRENT_RELEASE" old_mode="$INSTALL_MODE" target_mode="${PREVIOUS_MODE:-$INSTALL_MODE}"
  new_slot="$(other_slot "$old_slot")"
  INSTALL_MODE="$target_mode"
  write_service_unit
  write_nginx_site
  activate_release "$new_slot" "$target_release" "$old_slot"
  write_state "$new_slot" "$target_release" "$old_release" "$old_mode"
  note "ROLLBACK_PASS release=$target_release slot=$new_slot"
}

uninstall_action() {
  load_state
  local erase_data='no'
  if [[ "$NON_INTERACTIVE" == true ]]; then
    erase_data="${KAIGEN_UNINSTALL_ERASE_DATA:-no}"
  else
    read -r -p 'Preserve encrypted workspace data? [Y/n]: ' answer
    case "${answer:-Y}" in Y|y|yes|YES) erase_data='no' ;; N|n|no|NO) erase_data='yes' ;; *) fail 'Answer Y or N.' ;; esac
    if [[ "$erase_data" == 'yes' ]]; then
      read -r -p 'Type ERASE to remove all Kaigen Web workspace data: ' confirmation
      [[ "$confirmation" == 'ERASE' ]] || fail 'Data erasure was not confirmed.'
    fi
  fi
  [[ "$erase_data" == 'yes' || "$erase_data" == 'no' ]] || fail 'KAIGEN_UNINSTALL_ERASE_DATA must be yes or no.'
  if [[ "$TEST_MODE" != '1' ]]; then
    systemctl disable --now kaigen-webd@a.service kaigen-webd@b.service 2>/dev/null || true
    systemctl disable --now 'run-kaigen\x2dwebd.mount' 2>/dev/null || true
  fi
  for target in "$NGINX_AVAILABLE" "$NGINX_UPSTREAM" "$SERVICE_UNIT" "$LIMITS_FILE" "$MOUNT_UNIT"; do
    if [[ -e "$target" ]]; then require_managed_or_absent "$target"; rm -f -- "$target"; fi
  done
  if [[ "$TEST_MODE" == '1' && -e "$NGINX_ENABLED" ]]; then
    require_managed_or_absent "$NGINX_ENABLED"
  else
    [[ ! -e "$NGINX_ENABLED" || -L "$NGINX_ENABLED" ]] || fail 'Enabled Nginx entry is not a symlink.'
  fi
  rm -f -- "$NGINX_ENABLED"
  rm -rf -- "$(root_path /opt/kaigen-webd)" "$ETC_DIR" "$LIMITS_DIR"
  if [[ "$erase_data" == 'yes' ]]; then rm -rf -- "$DATA_DIR"; else rm -f -- "$STATE_FILE"; fi
  if [[ "$TEST_MODE" != '1' ]]; then systemctl daemon-reload; nginx -t; systemctl reload nginx; fi
  note "UNINSTALL_PASS dataPreserved=$([[ "$erase_data" == 'no' ]] && echo true || echo false)"
}

check_debian
check_live_dependencies
case "$ACTION" in
  install) install_action ;;
  update) update_action ;;
  rollback) rollback_action ;;
  uninstall) uninstall_action ;;
esac
