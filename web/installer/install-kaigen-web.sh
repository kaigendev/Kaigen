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
readonly ROUTE_SNAPSHOTS_DIR="$ETC_DIR/installer-route-snapshots"
readonly ROUTE_SCHEMA_BUILD_ID='build-id-v1'
readonly ROUTE_SCHEMA_LEGACY='legacy-v0'

ROUTE_TRANSACTION_ACTIVE=false
ROUTE_TRANSACTION_SNAPSHOT=''
ROUTE_TRANSACTION_STATE_SHA=''
ROUTE_TRANSACTION_UPSTREAM_SHA=''
ROUTE_TRANSACTION_CURRENT=''
ROUTE_TRANSACTION_ACTIVE_SLOT=''

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

sha256_of() { sha256sum -- "$1" | awk '{ print toupper($1) }'; }

snapshot_value() {
  local snapshot="$1" key="$2"
  awk -F '\t' -v key="$key" '$1 == key { if (++seen > 1) exit 2; value=$2 } END { if (seen != 1) exit 3; print value }' "$snapshot/metadata.tsv"
}

validate_route_snapshot() {
  local snapshot="$1" expected_release="$2" expected_schema="$3" listed actual
  [[ "$snapshot" == "$ROUTE_SNAPSHOTS_DIR"/* && -d "$snapshot" && ! -L "$snapshot" ]] || fail 'Route snapshot path is invalid.'
  if [[ "$TEST_MODE" != '1' ]]; then
    [[ "$(readlink -f -- "$ROUTE_SNAPSHOTS_DIR")" == "$ROUTE_SNAPSHOTS_DIR" && "$(readlink -f -- "$snapshot")" == "$snapshot" ]] || fail 'Route snapshot path contains a symlink.'
    [[ "$(stat -c '%u:%g:%a' -- "$ROUTE_SNAPSHOTS_DIR")" == '0:0:700' && "$(stat -c '%u:%g:%a' -- "$snapshot")" == '0:0:700' ]] || fail 'Route snapshot ownership or mode is unsafe.'
    [[ -z "$(find "$snapshot" -type f \( ! -user root -o ! -group root -o ! -perm 0600 \) -print -quit)" ]] || fail 'Route snapshot file ownership or mode is unsafe.'
  fi
  [[ -f "$snapshot/metadata.tsv" && -f "$snapshot/nginx-site" && -f "$snapshot/nginx-upstream" && -f "$snapshot/service-unit" && -f "$snapshot/snapshot.sha256" ]] || fail 'Route snapshot is incomplete.'
  if find "$snapshot" -type l -print -quit | grep -q .; then fail 'Route snapshot contains a symlink.'; fi
  if find "$snapshot" ! -type d ! -type f -print -quit | grep -q .; then fail 'Route snapshot contains an unsupported object.'; fi
  listed="$(awk '{ print $2 }' "$snapshot/snapshot.sha256" | LC_ALL=C sort -u)"
  actual="$(cd -- "$snapshot" && find . -type f ! -name snapshot.sha256 -printf '%P\n' | LC_ALL=C sort -u)"
  [[ "$listed" == "$actual" ]] || fail 'Route snapshot inventory mismatch.'
  (cd -- "$snapshot" && sha256sum --check --strict snapshot.sha256 >/dev/null) || fail 'Route snapshot hash verification failed.'
  [[ "$(snapshot_value "$snapshot" schemaVersion)" == '1' ]] || fail 'Route snapshot schema is unsupported.'
  [[ "$(snapshot_value "$snapshot" releaseId)" == "$expected_release" ]] || fail 'Route snapshot release mismatch.'
  [[ "$(snapshot_value "$snapshot" routeSchema)" == "$expected_schema" ]] || fail 'Route snapshot route schema mismatch.'
  [[ "$(snapshot_value "$snapshot" activeSlot)" == 'a' || "$(snapshot_value "$snapshot" activeSlot)" == 'b' ]] || fail 'Route snapshot active slot is invalid.'
}

create_route_snapshot() {
  local release_id="$1" route_schema="$2" staging limits_present='false' enabled_kind enabled_target
  [[ "$release_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]] || fail 'Cannot snapshot an invalid release id.'
  [[ "$route_schema" == "$ROUTE_SCHEMA_BUILD_ID" || "$route_schema" == "$ROUTE_SCHEMA_LEGACY" ]] || fail 'Cannot snapshot an invalid route schema.'
  require_managed_or_absent "$NGINX_AVAILABLE"
  require_managed_or_absent "$SERVICE_UNIT"
  [[ -f "$NGINX_AVAILABLE" && ! -L "$NGINX_AVAILABLE" && -f "$SERVICE_UNIT" && ! -L "$SERVICE_UNIT" ]] || fail 'Managed shared route files are missing.'
  [[ ! -e "$ROUTE_SNAPSHOTS_DIR" || ( -d "$ROUTE_SNAPSHOTS_DIR" && ! -L "$ROUTE_SNAPSHOTS_DIR" ) ]] || fail 'Route snapshot root is unsafe.'
  mkdir -p -- "$ROUTE_SNAPSHOTS_DIR"
  if [[ "$TEST_MODE" != '1' ]]; then
    [[ -d "$ETC_DIR" && ! -L "$ETC_DIR" && "$(readlink -f -- "$ETC_DIR")" == "$ETC_DIR" ]] || fail 'Installer configuration path is unsafe.'
    chown root:root -- "$ROUTE_SNAPSHOTS_DIR"
  fi
  chmod 0700 -- "$ROUTE_SNAPSHOTS_DIR"
  if [[ "$TEST_MODE" != '1' ]]; then
    [[ "$(readlink -f -- "$ROUTE_SNAPSHOTS_DIR")" == "$ROUTE_SNAPSHOTS_DIR" && "$(stat -c '%u:%g:%a' -- "$ROUTE_SNAPSHOTS_DIR")" == '0:0:700' ]] || fail 'Route snapshot root ownership or mode is unsafe.'
  fi
  staging="$(mktemp -d "$ROUTE_SNAPSHOTS_DIR/.staging-$release_id.XXXXXX")"
  chmod 0700 -- "$staging"
  install -m 0600 -- "$NGINX_AVAILABLE" "$staging/nginx-site"
  require_managed_or_absent "$NGINX_UPSTREAM"
  [[ -f "$NGINX_UPSTREAM" && ! -L "$NGINX_UPSTREAM" ]] || fail 'Managed Nginx upstream is missing.'
  install -m 0600 -- "$NGINX_UPSTREAM" "$staging/nginx-upstream"
  install -m 0600 -- "$SERVICE_UNIT" "$staging/service-unit"
  if [[ -e "$LIMITS_FILE" ]]; then
    require_managed_or_absent "$LIMITS_FILE"
    [[ -f "$LIMITS_FILE" && ! -L "$LIMITS_FILE" ]] || fail 'Managed service limits are not a regular file.'
    install -m 0600 -- "$LIMITS_FILE" "$staging/limits-file"
    limits_present='true'
  fi
  if [[ "$TEST_MODE" == '1' ]]; then
    require_managed_or_absent "$NGINX_ENABLED"
    [[ -f "$NGINX_ENABLED" && ! -L "$NGINX_ENABLED" ]] || fail 'Test enabled-site metadata is invalid.'
    install -m 0600 -- "$NGINX_ENABLED" "$staging/enabled-test-file"
    enabled_kind='test-file'
    enabled_target='../sites-available/kaigen-web'
  else
    [[ -L "$NGINX_ENABLED" ]] || fail 'Enabled Nginx site is not a symlink.'
    enabled_kind='symlink'
    enabled_target="$(readlink -- "$NGINX_ENABLED")"
    [[ "$enabled_target" == '../sites-available/kaigen-web' ]] || fail 'Enabled Nginx site has an unexpected target.'
  fi
  cat > "$staging/metadata.tsv" <<EOF
schemaVersion	1
releaseId	$release_id
routeSchema	$route_schema
activeSlot	$ACTIVE_SLOT
limitsPresent	$limits_present
enabledKind	$enabled_kind
enabledTarget	$enabled_target
EOF
  chmod 0600 -- "$staging/metadata.tsv"
  (
    cd -- "$staging"
    find . -type f ! -name snapshot.sha256 -printf '%P\0' | LC_ALL=C sort -z |
      while IFS= read -r -d '' relative; do printf '%s  %s\n' "$(sha256sum "$relative" | awk '{print $1}')" "$relative"; done > snapshot.sha256
    chmod 0600 -- snapshot.sha256
  )
  validate_route_snapshot "$staging" "$release_id" "$route_schema"
  printf '%s' "$staging"
}

persist_route_snapshot() {
  local staging="$1" release_id="$2" route_schema="$3" target
  target="$ROUTE_SNAPSHOTS_DIR/$release_id"
  validate_route_snapshot "$staging" "$release_id" "$route_schema"
  if [[ -e "$target" ]]; then
    validate_route_snapshot "$target" "$release_id" "$route_schema"
    cmp -s -- "$staging/snapshot.sha256" "$target/snapshot.sha256" || fail 'Existing route snapshot has different content.'
    rm -rf -- "$staging"
  else
    mv -- "$staging" "$target"
  fi
  printf '%s' "$target"
}

atomic_copy() {
  local source="$1" target="$2" mode="$3"
  atomic_write "$target" "$mode" < "$source"
}

restore_route_snapshot() {
  local snapshot="$1" release_id="$2" route_schema="$3" limits_present enabled_kind enabled_target
  validate_route_snapshot "$snapshot" "$release_id" "$route_schema"
  limits_present="$(snapshot_value "$snapshot" limitsPresent)"
  enabled_kind="$(snapshot_value "$snapshot" enabledKind)"
  enabled_target="$(snapshot_value "$snapshot" enabledTarget)"
  [[ "$limits_present" == 'true' || "$limits_present" == 'false' ]] || fail 'Route snapshot limits metadata is invalid.'
  atomic_copy "$snapshot/nginx-site" "$NGINX_AVAILABLE" 0644
  atomic_copy "$snapshot/service-unit" "$SERVICE_UNIT" 0644
  if [[ "$limits_present" == 'true' ]]; then
    [[ -f "$snapshot/limits-file" ]] || fail 'Route snapshot limits file is missing.'
    atomic_copy "$snapshot/limits-file" "$LIMITS_FILE" 0644
  else
    if [[ -e "$LIMITS_FILE" ]]; then require_managed_or_absent "$LIMITS_FILE"; rm -f -- "$LIMITS_FILE"; fi
  fi
  if [[ "$TEST_MODE" == '1' ]]; then
    [[ "$enabled_kind" == 'test-file' && -f "$snapshot/enabled-test-file" ]] || fail 'Test enabled-site snapshot is invalid.'
    atomic_copy "$snapshot/enabled-test-file" "$NGINX_ENABLED" 0644
  else
    [[ "$enabled_kind" == 'symlink' && "$enabled_target" == '../sites-available/kaigen-web' ]] || fail 'Enabled-site snapshot metadata is invalid.'
    [[ ! -e "$NGINX_ENABLED" || -L "$NGINX_ENABLED" ]] || fail 'Refusing to replace a non-symlink enabled Nginx site.'
    ln -s -- "$enabled_target" "$NGINX_ENABLED.restore"
    mv -fT -- "$NGINX_ENABLED.restore" "$NGINX_ENABLED"
  fi
}

detect_current_route_schema() {
  local release_id="$1" build_id_file
  build_id_file="$RELEASES_DIR/$release_id/ui/kaigen-build-id"
  local site_has_build_id='false' upstream_has_build_id='false'
  grep -Fq '$kaigen_web_build_id' "$NGINX_AVAILABLE" && site_has_build_id='true'
  grep -Fqx -- "set \$kaigen_web_build_id $release_id;" "$NGINX_UPSTREAM" && upstream_has_build_id='true'
  if [[ -f "$build_id_file" ]]; then
    [[ "$(cat -- "$build_id_file")" == "$release_id" && "$site_has_build_id" == 'true' && "$upstream_has_build_id" == 'true' ]] || fail 'Current build-id route is internally inconsistent.'
    printf '%s' "$ROUTE_SCHEMA_BUILD_ID"
  else
    [[ "$site_has_build_id" == 'false' ]] || fail 'Legacy route unexpectedly requires a missing UI build identity.'
    printf '%s' "$ROUTE_SCHEMA_LEGACY"
  fi
}

current_route_pointer() {
  if [[ "$TEST_MODE" == '1' ]]; then
    [[ -f "$CURRENT_LINK.test-target" ]] || return 1
    cat -- "$CURRENT_LINK.test-target"
  else
    [[ -L "$CURRENT_LINK" ]] || return 1
    readlink -- "$CURRENT_LINK"
  fi
}

validate_active_route_binding() {
  local expected_current="$CURRENT_RELEASE" expected_port
  if [[ "$TEST_MODE" != '1' ]]; then expected_current="releases/$CURRENT_RELEASE"; fi
  [[ "$(current_route_pointer)" == "$expected_current" ]] || fail 'Installer state does not match the active release target.'
  expected_port="$(slot_port "$ACTIVE_SLOT")"
  grep -Fqx -- "set \$kaigen_web_backend http://127.0.0.1:$expected_port;" "$NGINX_UPSTREAM" || fail 'Installer state does not match the active upstream port.'
}

route_precommit_unchanged() {
  [[ "$(sha256_of "$STATE_FILE")" == "$ROUTE_TRANSACTION_STATE_SHA" ]] || return 1
  [[ "$(sha256_of "$NGINX_UPSTREAM")" == "$ROUTE_TRANSACTION_UPSTREAM_SHA" ]] || return 1
  [[ "$(current_route_pointer)" == "$ROUTE_TRANSACTION_CURRENT" ]] || return 1
  if [[ "$TEST_MODE" != '1' ]]; then systemctl is-active --quiet "kaigen-webd@$ROUTE_TRANSACTION_ACTIVE_SLOT.service" || return 1; fi
}

abort_route_transaction() {
  local status=$?
  [[ "$ROUTE_TRANSACTION_ACTIVE" == 'true' ]] || return
  trap - EXIT
  if ! route_precommit_unchanged; then
    printf 'ERROR: Shared-route transaction failed after route commit or concurrent drift; refusing automatic reconstruction.\n' >&2
    exit "$status"
  fi
  rm -f -- "$STATE_FILE.new"
  restore_route_snapshot "$ROUTE_TRANSACTION_SNAPSHOT" "$ROUTE_TRANSACTION_RELEASE" "$ROUTE_TRANSACTION_SCHEMA"
  if [[ "$TEST_MODE" != '1' ]]; then
    systemctl daemon-reload
    nginx -t
    systemctl reload nginx
    local port
    port="$(slot_port "$ROUTE_TRANSACTION_ACTIVE_SLOT")"
    curl --fail --silent --show-error "http://127.0.0.1:$port/healthz" >/dev/null
    curl --fail --silent --show-error "http://127.0.0.1:$port/readyz" >/dev/null
  fi
  printf 'Shared-route pre-commit state restored after failed activation.\n' >&2
  exit "$status"
}

begin_route_transaction() {
  local snapshot="$1" release_id="$2" route_schema="$3"
  if [[ "$TEST_MODE" != '1' ]]; then
    systemctl is-active --quiet "kaigen-webd@$ACTIVE_SLOT.service" || fail 'Installer state active slot is not running.'
  fi
  ROUTE_TRANSACTION_SNAPSHOT="$snapshot"
  ROUTE_TRANSACTION_RELEASE="$release_id"
  ROUTE_TRANSACTION_SCHEMA="$route_schema"
  ROUTE_TRANSACTION_STATE_SHA="$(sha256_of "$STATE_FILE")"
  ROUTE_TRANSACTION_UPSTREAM_SHA="$(sha256_of "$NGINX_UPSTREAM")"
  ROUTE_TRANSACTION_CURRENT="$(current_route_pointer)"
  ROUTE_TRANSACTION_ACTIVE_SLOT="$ACTIVE_SLOT"
  ROUTE_TRANSACTION_ACTIVE=true
  trap abort_route_transaction EXIT
}

end_route_transaction() {
  ROUTE_TRANSACTION_ACTIVE=false
  trap - EXIT
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

write_state_to() {
  local target="$1" active_slot="$2" current_release="$3" previous_release="$4" previous_mode="$5"
  local current_route_schema="$6" previous_route_schema="$7" previous_route_snapshot="$8"
  atomic_write "$target" 0600 <<EOF
$MANAGED_MARKER
ACTIVE_SLOT=$active_slot
CURRENT_RELEASE=$current_release
PREVIOUS_RELEASE=$previous_release
INSTALL_MODE=$INSTALL_MODE
PREVIOUS_MODE=$previous_mode
CURRENT_ROUTE_SCHEMA=$current_route_schema
PREVIOUS_ROUTE_SCHEMA=$previous_route_schema
PREVIOUS_ROUTE_SNAPSHOT=$previous_route_snapshot
PUBLIC_ORIGIN=$PUBLIC_ORIGIN
HOSTNAME=$INSTALL_HOSTNAME
TLS_CERT=$INSTALL_TLS_CERT
TLS_KEY=$INSTALL_TLS_KEY
EOF
}

write_state() { write_state_to "$STATE_FILE" "$@"; }

stage_state() {
  [[ ! -e "$STATE_FILE.new" && ! -L "$STATE_FILE.new" ]] || fail 'Staged installer state already exists or is unsafe.'
  write_state_to "$STATE_FILE.new" "$@"
}

secure_state_storage() {
  [[ -d "$DATA_DIR" && ! -L "$DATA_DIR" ]] || fail 'Installer data directory is missing or unsafe.'
  if [[ "$TEST_MODE" != '1' ]]; then
    [[ "$(readlink -f -- "$DATA_DIR")" == "$DATA_DIR" ]] || fail 'Installer data path contains a symlink.'
  fi
  # Legacy installers made DATA_DIR service-owned. Its parent (/var/lib) is not
  # service-writable, so taking ownership first closes replacement of STATE_FILE
  # before any of its shell assignments are trusted.
  if [[ "$TEST_MODE" != '1' ]]; then
    chown root:root -- "$DATA_DIR"
    chmod 0755 -- "$DATA_DIR"
    [[ "$(stat -c '%u:%g:%a' -- "$DATA_DIR")" == '0:0:755' ]] || fail 'Installer data directory ownership or mode is unsafe.'
  else
    chmod 0755 -- "$DATA_DIR"
  fi
  [[ -f "$STATE_FILE" && ! -L "$STATE_FILE" ]] || fail 'Installer state is not a regular file.'
  if [[ "$TEST_MODE" == '1' ]]; then
    case "$(uname -s)" in
      MINGW*|MSYS*) ;; # NTFS mode emulation cannot represent root:0600.
      *) [[ "$(stat -c '%u:%g:%a' -- "$STATE_FILE")" == "$(id -u):$(id -g):600" ]] || fail 'Installer state ownership or mode is unsafe.' ;;
    esac
  else
    [[ "$(stat -c '%u:%g:%a' -- "$STATE_FILE")" == '0:0:600' ]] || fail 'Installer state ownership or mode is unsafe.'
  fi
  [[ ! -e "$DATA_DIR/disk" || ( -d "$DATA_DIR/disk" && ! -L "$DATA_DIR/disk" ) ]] || fail 'Workspace data path is unsafe.'
}

load_state() {
  secure_state_storage
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
  validate_active_route_binding
  CURRENT_ROUTE_SCHEMA="${CURRENT_ROUTE_SCHEMA:-$(detect_current_route_schema "$CURRENT_RELEASE")}"
  [[ "$CURRENT_ROUTE_SCHEMA" == "$ROUTE_SCHEMA_BUILD_ID" || "$CURRENT_ROUTE_SCHEMA" == "$ROUTE_SCHEMA_LEGACY" ]] || fail 'Installer state has an invalid current route schema.'
  [[ "$(detect_current_route_schema "$CURRENT_RELEASE")" == "$CURRENT_ROUTE_SCHEMA" ]] || fail 'Installer route schema does not match the active release.'
  PREVIOUS_ROUTE_SCHEMA="${PREVIOUS_ROUTE_SCHEMA:-}"
  PREVIOUS_ROUTE_SNAPSHOT="${PREVIOUS_ROUTE_SNAPSHOT:-}"
  PREVIOUS_ROUTE_METADATA_AVAILABLE=false
  if [[ -n "${PREVIOUS_RELEASE:-}" ]]; then
    if [[ -z "$PREVIOUS_ROUTE_SCHEMA" && -z "$PREVIOUS_ROUTE_SNAPSHOT" ]]; then
      PREVIOUS_ROUTE_METADATA_AVAILABLE=false
    else
      [[ "$PREVIOUS_ROUTE_SCHEMA" == "$ROUTE_SCHEMA_BUILD_ID" || "$PREVIOUS_ROUTE_SCHEMA" == "$ROUTE_SCHEMA_LEGACY" ]] || fail 'Installer state has an invalid previous route schema.'
      [[ "$PREVIOUS_ROUTE_SNAPSHOT" == "$PREVIOUS_RELEASE" ]] || fail 'Installer state does not bind the previous route snapshot.'
      validate_route_snapshot "$ROUTE_SNAPSHOTS_DIR/$PREVIOUS_ROUTE_SNAPSHOT" "$PREVIOUS_RELEASE" "$PREVIOUS_ROUTE_SCHEMA"
      PREVIOUS_ROUTE_METADATA_AVAILABLE=true
    fi
  else
    [[ -z "$PREVIOUS_ROUTE_SCHEMA" && -z "$PREVIOUS_ROUTE_SNAPSHOT" ]] || fail 'Installer state has orphaned previous-route metadata.'
  fi
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
  local previous_link="$1" had_current="$2" current_backup="$3" had_upstream="$4" upstream_backup="$5" had_state="$6" state_backup="$7"
  rm -f -- "$CURRENT_LINK.new" "$CURRENT_LINK.test-target.new" "$NGINX_UPSTREAM.new" "$STATE_FILE.new"
  if [[ "$TEST_MODE" == '1' ]]; then
    if [[ "$had_current" == 'true' ]]; then
      mv -fT -- "$current_backup" "$CURRENT_LINK.test-target"
    else
      rm -f -- "$CURRENT_LINK.test-target" "$current_backup"
    fi
  elif [[ -n "$previous_link" ]]; then
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
  if [[ "$had_state" == 'true' ]]; then
    mv -fT -- "$state_backup" "$STATE_FILE"
  else
    rm -f -- "$STATE_FILE" "$state_backup"
  fi
}

commit_release_routes() {
  local slot="$1" release_id="$2" port="$3" route_schema="$4" route_snapshot="${5:-}" commit_state="${6:-false}"
  local previous_link='' had_current='false' current_backup='' had_upstream='false' upstream_backup had_state='false' state_backup
  local current_target="$CURRENT_LINK" snapshot_slot
  [[ "$commit_state" == 'true' || "$commit_state" == 'false' ]] || fail 'State commit policy is invalid.'
  if [[ "$commit_state" == 'true' ]]; then
    [[ -f "$STATE_FILE.new" && ! -L "$STATE_FILE.new" ]] || fail 'Staged installer state is missing or unsafe.'
    require_managed_or_absent "$STATE_FILE.new"
  fi
  if [[ -n "$route_snapshot" ]]; then
    validate_route_snapshot "$route_snapshot" "$release_id" "$route_schema"
    snapshot_slot="$(snapshot_value "$route_snapshot" activeSlot)"
    [[ "$snapshot_slot" == "$slot" ]] || fail 'Route snapshot slot does not match rollback target slot.'
    grep -Fqx -- "set \$kaigen_web_backend http://127.0.0.1:$port;" "$route_snapshot/nginx-upstream" || fail 'Route snapshot upstream does not match rollback target port.'
    if [[ "$route_schema" == "$ROUTE_SCHEMA_BUILD_ID" ]]; then
      grep -Fqx -- "set \$kaigen_web_build_id $release_id;" "$route_snapshot/nginx-upstream" || fail 'Route snapshot upstream does not match rollback build identity.'
    fi
  fi
  if [[ "$TEST_MODE" == '1' ]]; then
    current_target="$CURRENT_LINK.test-target"
    current_backup="$(mktemp "$(dirname -- "$current_target")/.kaigen-current-backup.XXXXXX")"
    if [[ -f "$current_target" && ! -L "$current_target" ]]; then
      cp -p -- "$current_target" "$current_backup"
      had_current='true'
    elif [[ -e "$current_target" ]]; then
      fail 'Current test release target is not a regular file.'
    fi
  elif [[ -L "$CURRENT_LINK" ]]; then
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
  state_backup="$(mktemp "$(dirname -- "$STATE_FILE")/.kaigen-state-backup.XXXXXX")"
  if [[ -f "$STATE_FILE" && ! -L "$STATE_FILE" ]]; then
    cp -p -- "$STATE_FILE" "$state_backup"
    had_state='true'
  elif [[ -e "$STATE_FILE" ]]; then
    fail 'Installer state is not a regular file.'
  fi
  rm -f -- "$CURRENT_LINK.new" "$CURRENT_LINK.test-target.new" "$NGINX_UPSTREAM.new"
  if [[ "$TEST_MODE" == '1' ]]; then
    atomic_write "$CURRENT_LINK.test-target.new" 0644 <<EOF
$release_id
EOF
  else
    ln -s -- "releases/$release_id" "$CURRENT_LINK.new"
  fi
  if [[ -n "$route_snapshot" ]]; then
    atomic_copy "$route_snapshot/nginx-upstream" "$NGINX_UPSTREAM.new" 0644
  else
    write_upstream "$port" "$release_id" "$NGINX_UPSTREAM.new"
  fi
  if [[ ! -e "$current_target.new" || ! -f "$NGINX_UPSTREAM.new" ]]; then
    rm -f -- "$CURRENT_LINK.new" "$CURRENT_LINK.test-target.new" "$NGINX_UPSTREAM.new" "$current_backup" "$upstream_backup" "$state_backup"
    stop_candidate_backend "$slot"
    fail 'Candidate release routes could not be staged.'
  fi
  local switch_failed='false'
  if ! mv -fT -- "$current_target.new" "$current_target" ||
     ! mv -fT -- "$NGINX_UPSTREAM.new" "$NGINX_UPSTREAM"; then
    switch_failed='true'
  elif [[ "$commit_state" == 'true' ]]; then
    if [[ "$TEST_MODE" == '1' && "${KAIGEN_INSTALL_TEST_ROUTE_COMMIT:-pass}" == 'fail-before-state' ]]; then
      switch_failed='true'
    elif ! mv -fT -- "$STATE_FILE.new" "$STATE_FILE"; then
      switch_failed='true'
    fi
  fi
  if [[ "$switch_failed" == 'true' ]]; then
    restore_release_routes "$previous_link" "$had_current" "$current_backup" "$had_upstream" "$upstream_backup" "$had_state" "$state_backup"
    stop_candidate_backend "$slot"
    fail 'Candidate release routes could not be switched.'
  fi
  if [[ "$TEST_MODE" == '1' ]]; then
    rm -f -- "$current_backup" "$upstream_backup" "$state_backup"
    return
  fi
  if ! nginx -t; then
    restore_release_routes "$previous_link" "$had_current" "$current_backup" "$had_upstream" "$upstream_backup" "$had_state" "$state_backup"
    stop_candidate_backend "$slot"
    fail 'Candidate Nginx route validation failed; previous release restored.'
  fi
  if ! systemctl reload nginx; then
    restore_release_routes "$previous_link" "$had_current" "$current_backup" "$had_upstream" "$upstream_backup" "$had_state" "$state_backup"
    nginx -t && systemctl reload nginx || true
    stop_candidate_backend "$slot"
    fail 'Candidate Nginx reload failed; previous release restored.'
  fi
  rm -f -- "$current_backup" "$upstream_backup" "$state_backup"
}

activate_release() {
  local slot="$1" release_id="$2" route_schema="$3" old_slot="${4:-}" route_snapshot="${5:-}" commit_state="${6:-false}" port
  local installed_build_id
  [[ -z "$old_slot" || "$slot" != "$old_slot" ]] || fail 'Candidate release must use the inactive slot.'
  if [[ "$route_schema" == "$ROUTE_SCHEMA_BUILD_ID" ]]; then
    [[ -f "$RELEASES_DIR/$release_id/ui/kaigen-build-id" ]] || fail 'Installed UI build identity is missing.'
    installed_build_id="$(cat -- "$RELEASES_DIR/$release_id/ui/kaigen-build-id")"
    [[ "$installed_build_id" == "$release_id" ]] || fail 'Installed UI build identity does not match release-id.'
  elif [[ "$route_schema" == "$ROUTE_SCHEMA_LEGACY" ]]; then
    [[ ! -e "$RELEASES_DIR/$release_id/ui/kaigen-build-id" ]] || fail 'Legacy release unexpectedly contains a build identity.'
  else
    fail 'Release route schema is invalid.'
  fi
  port="$(slot_port "$slot")"
  write_slot_env "$slot" "$release_id" "$port"
  start_candidate_backend "$slot" "$release_id"
  wait_for_candidate_backend "$slot" "$port"
  commit_release_routes "$slot" "$release_id" "$port" "$route_schema" "$route_snapshot" "$commit_state"
  if [[ "$ROUTE_TRANSACTION_ACTIVE" == 'true' ]]; then end_route_transaction; fi
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
  mkdir -p -- "$ETC_DIR" "$SLOT_DIR" "$DATA_DIR" "$RELEASES_DIR"
  [[ -d "$DATA_DIR" && ! -L "$DATA_DIR" ]] || fail 'Installer data directory is unsafe.'
  [[ ! -e "$DATA_DIR/disk" || ( -d "$DATA_DIR/disk" && ! -L "$DATA_DIR/disk" ) ]] || fail 'Workspace data path is unsafe.'
  mkdir -p -- "$DATA_DIR/disk"
  if [[ "$TEST_MODE" != '1' ]]; then
    if ! getent group "$SERVICE_GROUP" >/dev/null; then groupadd --system "$SERVICE_GROUP"; fi
    if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
      useradd --system --gid "$SERVICE_GROUP" --home-dir /var/lib/kaigen-webd --shell /usr/sbin/nologin "$SERVICE_USER"
    fi
    chown root:root "$ETC_DIR" "$SLOT_DIR" "$INSTALL_DIR" "$RELEASES_DIR"
    chmod 0755 -- "$ETC_DIR" "$SLOT_DIR"
    chmod 0755 -- "$INSTALL_DIR" "$RELEASES_DIR"
    chown root:root -- "$DATA_DIR"
    chmod 0755 -- "$DATA_DIR"
    chown "$SERVICE_USER:$SERVICE_GROUP" -- "$DATA_DIR/disk"
    chmod 0700 -- "$DATA_DIR/disk"
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
  activate_release a "$RELEASE_ID" "$ROUTE_SCHEMA_BUILD_ID"
  write_state a "$RELEASE_ID" '' '' "$ROUTE_SCHEMA_BUILD_ID" '' ''
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
  local old_route_schema="$CURRENT_ROUTE_SCHEMA" route_snapshot staging_snapshot
  new_slot="$(other_slot "$old_slot")"
  staging_snapshot="$(create_route_snapshot "$old_release" "$old_route_schema")"
  route_snapshot="$(persist_route_snapshot "$staging_snapshot" "$old_release" "$old_route_schema")"
  begin_route_transaction "$route_snapshot" "$old_release" "$old_route_schema"
  install_release
  write_service_unit
  write_nginx_site
  stage_state "$new_slot" "$RELEASE_ID" "$old_release" "$old_mode" "$ROUTE_SCHEMA_BUILD_ID" "$old_route_schema" "$old_release"
  activate_release "$new_slot" "$RELEASE_ID" "$ROUTE_SCHEMA_BUILD_ID" "$old_slot" '' true
  end_route_transaction
  note "UPDATE_PASS release=$RELEASE_ID slot=$new_slot"
}

rollback_action() {
  load_state
  [[ -n "${PREVIOUS_RELEASE:-}" ]] || fail 'No previous release is available for rollback.'
  [[ "$PREVIOUS_ROUTE_METADATA_AVAILABLE" == 'true' ]] || fail 'Previous release lacks route metadata; run a successful update before rollback.'
  [[ -d "$RELEASES_DIR/$PREVIOUS_RELEASE" ]] || fail 'Previous release directory is missing.'
  local old_slot="$ACTIVE_SLOT" new_slot target_release="$PREVIOUS_RELEASE" old_release="$CURRENT_RELEASE" old_mode="$INSTALL_MODE" target_mode="${PREVIOUS_MODE:-$INSTALL_MODE}"
  local old_route_schema="$CURRENT_ROUTE_SCHEMA" target_route_schema="$PREVIOUS_ROUTE_SCHEMA"
  local current_snapshot_staging current_snapshot target_snapshot="$ROUTE_SNAPSHOTS_DIR/$PREVIOUS_ROUTE_SNAPSHOT"
  new_slot="$(other_slot "$old_slot")"
  current_snapshot_staging="$(create_route_snapshot "$old_release" "$old_route_schema")"
  current_snapshot="$(persist_route_snapshot "$current_snapshot_staging" "$old_release" "$old_route_schema")"
  begin_route_transaction "$current_snapshot" "$old_release" "$old_route_schema"
  INSTALL_MODE="$target_mode"
  restore_route_snapshot "$target_snapshot" "$target_release" "$target_route_schema"
  stage_state "$new_slot" "$target_release" "$old_release" "$old_mode" "$target_route_schema" "$old_route_schema" "$old_release"
  activate_release "$new_slot" "$target_release" "$target_route_schema" "$old_slot" "$target_snapshot" true
  end_route_transaction
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
