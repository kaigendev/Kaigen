#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
artifacts_dir="${1:-$project_root/artifacts}"
artifacts_dir="$(mkdir -p "$artifacts_dir" && cd "$artifacts_dir" && pwd)"

for command in cargo npm zip find; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is missing: $command" >&2
    exit 1
  fi
done

"$project_root/scripts/prepare-unix-dependencies.sh" linux

tox_lib_dir="$project_root/work/platform/linux/toxcore/lib"
tor_lib_dir="$project_root/work/platform/linux/TorExpertBundle/tor"
export KAIGEN_TOXCORE_LIB_DIR="$tox_lib_dir"
export LD_LIBRARY_PATH="$tox_lib_dir:$tor_lib_dir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

cd "$project_root"
npm ci
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run tauri -- build \
  --verbose \
  --config src-tauri/tauri.linux.conf.json \
  --bundles appimage

appimage="$(find "$project_root/src-tauri/target/release/bundle/appimage" \
  -maxdepth 1 -type f -name '*.AppImage' -print -quit)"
if [[ -z "$appimage" || ! -f "$appimage" ]]; then
  echo "Tauri did not produce an AppImage" >&2
  exit 1
fi

stage="$artifacts_dir/Kaigen-portable-debian-x64"
case "$stage" in
  "$artifacts_dir"/*) ;;
  *) echo "Unsafe staging path: $stage" >&2; exit 1 ;;
esac
rm -rf "$stage"
mkdir -p "$stage/data" "$stage/downloads" "$stage/profiles"
install -m 0755 "$appimage" "$stage/Kaigen-x86_64.AppImage"
install -m 0644 "$project_root/packaging/PORTABLE-LINUX.txt" "$stage/PORTABLE.txt"
install -m 0644 "$project_root/README.md" "$stage/README.md"
install -m 0644 "$project_root/POST_QUANTUM.txt" "$stage/POST_QUANTUM.txt"
install -m 0644 "$project_root/THIRD_PARTY_NOTICES.md" "$stage/THIRD_PARTY_NOTICES.md"

if find "$stage" -type f \( -name '*.tox' -o -name '*.db' \) -print -quit | grep -q .; then
  echo "Private profile or database found in portable stage" >&2
  exit 1
fi

extract_dir="$artifacts_dir/.kaigen-appimage-check"
rm -rf "$extract_dir"
mkdir -p "$extract_dir"
(
  cd "$extract_dir"
  "$stage/Kaigen-x86_64.AppImage" --appimage-extract >/dev/null
)
appdir="$extract_dir/squashfs-root"
for required in \
  usr/lib/libtoxcore.so.2 \
  usr/lib/Kaigen/libtoxcore.so \
  usr/lib/Kaigen/libtoxcore.so.2 \
  usr/lib/Kaigen/TorExpertBundle/tor/tor \
  usr/lib/Kaigen/TorExpertBundle/tor/pluggable_transports/lyrebird; do
  if [[ ! -e "$appdir/$required" ]]; then
    echo "AppImage is missing $required" >&2
    exit 1
  fi
done
app_executable="$appdir/usr/bin/tox-pq-client"
if [[ ! -x "$app_executable" ]]; then
  echo "AppImage contains no executable tox-pq-client" >&2
  exit 1
fi
if command -v readelf >/dev/null 2>&1; then
  if ! readelf -h "$app_executable" >/dev/null; then
    echo "AppImage tox-pq-client is not a valid ELF executable" >&2
    exit 1
  fi
  dynamic_section="$(readelf -d "$app_executable")"
  if ! grep -Fq 'Shared library: [libtoxcore.so.2]' <<<"$dynamic_section"; then
    echo "AppImage executable is not linked to the bundled toxcore soname" >&2
    exit 1
  fi
  if ! grep -Fq '$ORIGIN/../lib' <<<"$dynamic_section"; then
    echo "AppImage executable has no portable library rpath" >&2
    exit 1
  fi
fi
rm -rf "$extract_dir"

archive="$artifacts_dir/Kaigen-portable-debian-x64.zip"
rm -f "$archive"
(
  cd "$artifacts_dir"
  zip -9 -q -r "$(basename "$archive")" "$(basename "$stage")"
)
echo "Debian portable archive: $archive"
sha256sum "$archive"
