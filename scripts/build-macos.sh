#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
artifacts_dir="${1:-$project_root/artifacts}"
artifacts_dir="$(mkdir -p "$artifacts_dir" && cd "$artifacts_dir" && pwd)"

for command in cargo npm cmake ninja lipo otool install_name_tool codesign hdiutil ditto; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is missing: $command" >&2
    exit 1
  fi
done

rustup target add aarch64-apple-darwin x86_64-apple-darwin
"$project_root/scripts/prepare-unix-dependencies.sh" macos

tox_lib_dir="$project_root/work/platform/macos/toxcore/lib"
export KAIGEN_TOXCORE_LIB_DIR="$tox_lib_dir"
export DYLD_LIBRARY_PATH="$tox_lib_dir${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
export MACOSX_DEPLOYMENT_TARGET=11.0

cd "$project_root"
npm ci
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run tauri -- build \
  --target universal-apple-darwin \
  --config src-tauri/tauri.macos.conf.json \
  --bundles app

built_app="$(find "$project_root/src-tauri/target/universal-apple-darwin/release/bundle/macos" \
  -maxdepth 1 -type d -name '*.app' -print -quit)"
if [[ -z "$built_app" || ! -d "$built_app" ]]; then
  echo "Tauri did not produce a macOS application bundle" >&2
  exit 1
fi

stage="$artifacts_dir/Kaigen-portable-macos-universal"
case "$stage" in
  "$artifacts_dir"/*) ;;
  *) echo "Unsafe staging path: $stage" >&2; exit 1 ;;
esac
rm -rf "$stage"
mkdir -p "$stage/Kaigen-portable-data/data" \
  "$stage/Kaigen-portable-data/downloads" \
  "$stage/Kaigen-portable-data/profiles"
ditto "$built_app" "$stage/Kaigen.app"

app="$stage/Kaigen.app"
frameworks="$app/Contents/Frameworks"
mkdir -p "$frameworks"
install -m 0755 "$tox_lib_dir/libtoxcore.dylib" "$frameworks/libtoxcore.dylib"
install_name_tool -id '@rpath/libtoxcore.dylib' "$frameworks/libtoxcore.dylib"

executable_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
executable="$app/Contents/MacOS/$executable_name"
tox_reference="$(otool -L "$executable" | awk '$1 ~ /libtoxcore.*\.dylib$/ {print $1; exit}')"
if [[ -z "$tox_reference" ]]; then
  echo "The macOS executable is not linked to libtoxcore.dylib" >&2
  exit 1
fi
if [[ "$tox_reference" != '@rpath/libtoxcore.dylib' ]]; then
  install_name_tool -change "$tox_reference" '@rpath/libtoxcore.dylib' "$executable"
fi

for required in \
  Contents/Resources/TorExpertBundle/tor/tor \
  Contents/Resources/TorExpertBundle/tor/pluggable_transports/lyrebird \
  Contents/Frameworks/libtoxcore.dylib; do
  if [[ ! -e "$app/$required" ]]; then
    echo "macOS application is missing $required" >&2
    exit 1
  fi
done
for binary in \
  "$executable" \
  "$frameworks/libtoxcore.dylib" \
  "$app/Contents/Resources/TorExpertBundle/tor/tor" \
  "$app/Contents/Resources/TorExpertBundle/tor/pluggable_transports/lyrebird"; do
  architectures="$(lipo -archs "$binary")"
  if [[ "$architectures" != *x86_64* || "$architectures" != *arm64* ]]; then
    echo "$binary is not universal (found: $architectures)" >&2
    exit 1
  fi
done

identity="${KAIGEN_CODESIGN_IDENTITY:--}"
if [[ "$identity" == '-' ]]; then
  codesign --force --deep --sign - "$app"
else
  codesign --force --deep --options runtime --timestamp --sign "$identity" "$app"
fi
codesign --verify --deep --strict --verbose=2 "$app"

install -m 0644 "$project_root/packaging/PORTABLE-MACOS.txt" "$stage/PORTABLE.txt"
install -m 0644 "$project_root/README.md" "$stage/README.md"
install -m 0644 "$project_root/POST_QUANTUM.txt" "$stage/POST_QUANTUM.txt"
install -m 0644 "$project_root/THIRD_PARTY_NOTICES.md" "$stage/THIRD_PARTY_NOTICES.md"

dmg_root="$artifacts_dir/.kaigen-dmg-root"
rm -rf "$dmg_root"
mkdir -p "$dmg_root"
ditto "$app" "$dmg_root/Kaigen.app"
ditto "$stage/Kaigen-portable-data" "$dmg_root/Kaigen-portable-data"
install -m 0644 "$project_root/packaging/PORTABLE-MACOS.txt" "$dmg_root/READ-ME-FIRST.txt"
dmg="$stage/Kaigen-portable-macos-universal.dmg"
rm -f "$dmg"
hdiutil create -quiet -volname 'Kaigen Portable' -srcfolder "$dmg_root" -ov -format UDZO "$dmg"
rm -rf "$dmg_root"
hdiutil verify "$dmg"

if find "$stage/Kaigen-portable-data" -type f \( -name '*.tox' -o -name '*.db' \) -print -quit | grep -q .; then
  echo "Private profile or database found in portable stage" >&2
  exit 1
fi

archive="$artifacts_dir/Kaigen-portable-macos-universal.zip"
rm -f "$archive"
(
  cd "$artifacts_dir"
  ditto -c -k --sequesterRsrc --keepParent "$(basename "$stage")" "$(basename "$archive")"
)
echo "macOS portable archive: $archive"
shasum -a 256 "$archive"
