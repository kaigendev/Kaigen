#!/usr/bin/env bash
set -euo pipefail

REPOSITORY='kaigendev/Kaigen'
RELEASE_LABEL='__KAIGEN_RELEASE_LABEL__'
BUILD_ID='__KAIGEN_WEB_BUILD_ID__'
RELEASE_TAG="v$RELEASE_LABEL"
BUNDLE_NAME="Kaigen-Web-Debian13-Nginx-$RELEASE_LABEL.tar.gz"
BUNDLE_SHA256='__KAIGEN_WEB_BUNDLE_SHA256__'
DOWNLOAD_URL="https://github.com/$REPOSITORY/releases/download/$RELEASE_TAG/$BUNDLE_NAME"

fail() {
  printf 'Kaigen Web bootstrap installer: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage:
  sudo ./Kaigen-Web-Installer-$RELEASE_LABEL.sh [install|update] [installer options]

The bootstrap downloads the exact $RELEASE_TAG Web bundle from GitHub,
verifies its pinned SHA-256, verifies the bundle manifest, and delegates to
the bundled Debian 13 + Nginx installer. Without non-interactive options the
installer asks the user to select Personal or Service mode.
EOF
}

if [[ "${1:-}" == '--help' || "${1:-}" == '-h' ]]; then
  usage
  exit 0
fi

ACTION="${1:-install}"
if (( $# > 0 )); then shift; fi
case "$ACTION" in
  install|update) ;;
  *) fail "Action must be install or update." ;;
esac

[[ "$(id -u)" == '0' ]] || fail 'Run this installer as root (for example with sudo).'
for command_name in curl sha256sum tar mktemp; do
  command -v "$command_name" >/dev/null 2>&1 || fail "Required command is missing: $command_name"
done
[[ "$RELEASE_LABEL" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Embedded release label is invalid.'
[[ "$BUILD_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{11,79}$ ]] || fail 'Embedded build identity is invalid.'
[[ "$BUNDLE_SHA256" =~ ^[a-f0-9]{64}$ ]] || fail 'Embedded bundle SHA-256 is invalid.'

TEMP_ROOT="$(mktemp -d /tmp/kaigen-web-bootstrap.XXXXXXXX)"
cleanup() {
  rm -rf -- "$TEMP_ROOT"
}
trap cleanup EXIT HUP INT TERM

BUNDLE_PATH="$TEMP_ROOT/$BUNDLE_NAME"
EXTRACT_ROOT="$TEMP_ROOT/bundle"
mkdir -p -- "$EXTRACT_ROOT"
curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --retry-all-errors \
  --output "$BUNDLE_PATH" "$DOWNLOAD_URL"

ACTUAL_SHA256="$(sha256sum -- "$BUNDLE_PATH" | awk '{print $1}')"
[[ "$ACTUAL_SHA256" == "$BUNDLE_SHA256" ]] || fail 'Downloaded Web bundle SHA-256 does not match the release installer.'
tar -xzf "$BUNDLE_PATH" -C "$EXTRACT_ROOT"
[[ -f "$EXTRACT_ROOT/release-id" && ! -L "$EXTRACT_ROOT/release-id" ]] || fail 'Bundle release-id is missing or unsafe.'
[[ "$(tr -d '\r\n' < "$EXTRACT_ROOT/release-id")" == "$BUILD_ID" ]] || fail 'Bundle release-id does not match the bootstrap installer.'
[[ -f "$EXTRACT_ROOT/manifest.sha256" && ! -L "$EXTRACT_ROOT/manifest.sha256" ]] || fail 'Bundle manifest is missing or unsafe.'
(cd "$EXTRACT_ROOT" && sha256sum -c manifest.sha256)
INSTALLER="$EXTRACT_ROOT/install-kaigen-web.sh"
[[ -f "$INSTALLER" && ! -L "$INSTALLER" ]] || fail 'Bundled installer is missing or unsafe.'
chmod 0755 -- "$INSTALLER"

"$INSTALLER" "$ACTION" --bundle "$EXTRACT_ROOT" "$@"
