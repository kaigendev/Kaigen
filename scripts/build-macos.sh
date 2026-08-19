#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd -P)"
artifacts_dir="${1:-$project_root/artifacts}"
artifacts_dir="$(mkdir -p "$artifacts_dir" && cd "$artifacts_dir" && pwd -P)"
in_project_artifacts=''
case "$artifacts_dir" in
  "$project_root") echo "Artifacts directory must not equal the project root" >&2; exit 1 ;;
  "$project_root"/*) in_project_artifacts="$artifacts_dir" ;;
esac

distribution_mode="${KAIGEN_MACOS_DISTRIBUTION_MODE:-unsigned-test}"
identity="${KAIGEN_CODESIGN_IDENTITY:--}"
notary_profile="${KAIGEN_NOTARYTOOL_PROFILE:-}"
case "$distribution_mode" in
  distribution)
    if [[ "$identity" == '-' ]]; then
      echo "macOS distribution mode requires KAIGEN_CODESIGN_IDENTITY" >&2
      exit 1
    fi
    if [[ -z "$notary_profile" ]]; then
      echo "macOS distribution mode requires KAIGEN_NOTARYTOOL_PROFILE" >&2
      exit 1
    fi
    artifact_name='Kaigen-portable-macos-universal'
    dmg_volume_name='Kaigen Portable'
    ;;
  adhoc-release)
    if [[ "$identity" != '-' || -n "$notary_profile" ]]; then
      echo "adhoc-release mode must use ad-hoc signing and no notarization profile" >&2
      exit 1
    fi
    artifact_name='Kaigen-portable-macos-universal'
    dmg_volume_name='Kaigen Portable'
    ;;
  unsigned-test)
    if [[ "$identity" != '-' || -n "$notary_profile" ]]; then
      echo "unsigned-test mode must use ad-hoc signing and no notarization profile" >&2
      exit 1
    fi
    artifact_name='Kaigen-portable-macos-universal-UNSIGNED-TEST'
    dmg_volume_name='Kaigen UNSIGNED TEST'
    ;;
  *)
    echo "Unsupported KAIGEN_MACOS_DISTRIBUTION_MODE: $distribution_mode" >&2
    exit 1
    ;;
esac

for command in cargo npm cmake ninja lipo otool install_name_tool codesign hdiutil ditto find sort cmp diff mktemp readlink shasum; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is missing: $command" >&2
    exit 1
  fi
done

write_source_byte_manifest() {
  local destination="$1"
  find "$project_root" \
    \( -path "$project_root/.git" -o \
       -path "$project_root/node_modules" -o \
       -path "$project_root/dist" -o \
       -path "$project_root/src-tauri/target" -o \
       -path "$project_root/src-tauri/gen/schemas" -o \
       -path "$project_root/work" \) -prune -o \
    \( -type f -o -type l \) \
    ! -path "$project_root/.kaigen-lab-source" -print |
    LC_ALL=C sort |
    while IFS= read -r source_path; do
      if [[ -n "$in_project_artifacts" &&
            ( "$source_path" == "$in_project_artifacts" || "$source_path" == "$in_project_artifacts"/* ) ]]; then
        continue
      fi
      relative_path="${source_path#"$project_root"/}"
      if [[ -L "$source_path" ]]; then
        source_hash="$(printf '%s' "$(readlink "$source_path")" | shasum -a 256 | awk '{print $1}')"
        printf 'L\t%s\t%s\n' "$source_hash" "$relative_path"
      else
        source_hash="$(shasum -a 256 "$source_path" | awk '{print $1}')"
        printf 'F\t%s\t%s\n' "$source_hash" "$relative_path"
      fi
    done > "$destination"
}

source_manifest_before="$(mktemp "${TMPDIR:-/tmp}/kaigen-source-before.XXXXXX")"
source_manifest_after="$(mktemp "${TMPDIR:-/tmp}/kaigen-source-after.XXXXXX")"
cleanup_source_manifests() {
  rm -f "$source_manifest_before" "$source_manifest_after"
}
trap cleanup_source_manifests EXIT
write_source_byte_manifest "$source_manifest_before"

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

write_source_byte_manifest "$source_manifest_after"
if ! cmp -s "$source_manifest_before" "$source_manifest_after"; then
  echo "Source files changed during the macOS build:" >&2
  diff -u "$source_manifest_before" "$source_manifest_after" >&2 || true
  exit 1
fi

built_app="$(find "$project_root/src-tauri/target/universal-apple-darwin/release/bundle/macos" \
  -maxdepth 1 -type d -name '*.app' -print -quit)"
if [[ -z "$built_app" || ! -d "$built_app" ]]; then
  echo "Tauri did not produce a macOS application bundle" >&2
  exit 1
fi

stage="$artifacts_dir/$artifact_name"
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
if [[ "$executable_name" != 'Kaigen' ]]; then
  echo "Unexpected CFBundleExecutable: $executable_name (expected Kaigen)" >&2
  exit 1
fi
executable="$app/Contents/MacOS/$executable_name"
tox_reference="$(otool -L "$executable" | awk '$1 ~ /libtoxcore.*\.dylib$/ {print $1; exit}')"
if [[ -z "$tox_reference" ]]; then
  echo "The macOS executable is not linked to libtoxcore.dylib" >&2
  exit 1
fi
if [[ "$tox_reference" != '@rpath/libtoxcore.dylib' ]]; then
  install_name_tool -change "$tox_reference" '@rpath/libtoxcore.dylib' "$executable"
fi

# Mach-O helpers must live in code locations, not Contents/Resources where
# Gatekeeper seals them as data. Preserve Tor Expert Bundle's expected layout
# with relative symlinks while signing the real code in Helpers/Frameworks.
tor_resources="$app/Contents/Resources/TorExpertBundle/tor"
transport_resources="$tor_resources/pluggable_transports"
helpers="$app/Contents/Helpers"
mkdir -p "$helpers"
tor_helper="$helpers/kaigen-tor"
lyrebird_helper="$helpers/kaigen-lyrebird"
conjure_helper="$helpers/kaigen-conjure-client"
event_library="$frameworks/libevent-2.1.7.dylib"
mv "$tor_resources/tor" "$tor_helper"
mv "$tor_resources/libevent-2.1.7.dylib" "$event_library"
mv "$transport_resources/lyrebird" "$lyrebird_helper"
mv "$transport_resources/conjure-client" "$conjure_helper"
ln -s '../../../Helpers/kaigen-tor' "$tor_resources/tor"
ln -s '../../../Frameworks/libevent-2.1.7.dylib' "$tor_resources/libevent-2.1.7.dylib"
ln -s '../../../../Helpers/kaigen-lyrebird' "$transport_resources/lyrebird"
ln -s '../../../../Helpers/kaigen-conjure-client' "$transport_resources/conjure-client"

event_reference="$(otool -L "$tor_helper" | awk '$1 ~ /libevent.*\.dylib$/ {print $1; exit}')"
if [[ -z "$event_reference" ]]; then
  echo "The bundled Tor executable is not linked to libevent" >&2
  exit 1
fi
if [[ "$event_reference" != '@loader_path/../Frameworks/libevent-2.1.7.dylib' ]]; then
  install_name_tool -change "$event_reference" \
    '@loader_path/../Frameworks/libevent-2.1.7.dylib' "$tor_helper"
fi

for required in \
  Contents/Resources/TorExpertBundle/tor/tor \
  Contents/Resources/TorExpertBundle/tor/pluggable_transports/lyrebird \
  Contents/Resources/TorExpertBundle/tor/pluggable_transports/conjure-client \
  Contents/Helpers/kaigen-tor \
  Contents/Helpers/kaigen-lyrebird \
  Contents/Helpers/kaigen-conjure-client \
  Contents/Frameworks/libevent-2.1.7.dylib \
  Contents/Frameworks/libtoxcore.dylib; do
  if [[ ! -e "$app/$required" ]]; then
    echo "macOS application is missing $required" >&2
    exit 1
  fi
done
for binary in \
  "$executable" \
  "$frameworks/libtoxcore.dylib" \
  "$event_library" \
  "$tor_helper" \
  "$lyrebird_helper" \
  "$conjure_helper"; do
  architectures="$(lipo -archs "$binary")"
  if [[ "$architectures" != *x86_64* || "$architectures" != *arm64* ]]; then
    echo "$binary is not universal (found: $architectures)" >&2
    exit 1
  fi
done

sign_component() {
  local component="$1"
  if [[ "$identity" == '-' ]]; then
    codesign --force --sign - "$component"
  else
    codesign --force --options runtime --timestamp --sign "$identity" "$component"
  fi
}

# Sign nested code explicitly from the inside out. `--deep` remains a
# verification option only; Apple does not recommend it for signing.
for component in \
  "$frameworks/libtoxcore.dylib" \
  "$event_library" \
  "$tor_helper" \
  "$lyrebird_helper" \
  "$conjure_helper"; do
  sign_component "$component"
  codesign --verify --strict --verbose=2 "$component"
done
sign_component "$app"
codesign --verify --deep --strict --verbose=2 "$app"

if [[ "$distribution_mode" == 'distribution' ]]; then
  signature_details="$(codesign -dv --verbose=4 "$app" 2>&1)"
  if [[ "$signature_details" != *'Authority=Developer ID Application:'* ]]; then
    echo "macOS distribution mode did not produce a Developer ID Application signature" >&2
    exit 1
  fi
fi

if [[ -n "$notary_profile" ]]; then
  if [[ "$identity" == '-' ]]; then
    echo "KAIGEN_NOTARYTOOL_PROFILE requires a Developer ID signature" >&2
    exit 1
  fi
  if ! command -v xcrun >/dev/null 2>&1; then
    echo "xcrun is required for notarization" >&2
    exit 1
  fi
  app_submission="$artifacts_dir/.kaigen-notary-app.zip"
  rm -f "$app_submission"
  ditto -c -k --sequesterRsrc --keepParent "$app" "$app_submission"
  xcrun notarytool submit "$app_submission" \
    --keychain-profile "$notary_profile" --wait
  rm -f "$app_submission"
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
  codesign --verify --deep --strict --verbose=2 "$app"
fi

install -m 0644 "$project_root/packaging/PORTABLE-MACOS.txt" "$stage/PORTABLE.txt"
install -m 0644 "$project_root/README.md" "$stage/README.md"
install -m 0644 "$project_root/POST_QUANTUM.txt" "$stage/POST_QUANTUM.txt"
install -m 0644 "$project_root/THIRD_PARTY_NOTICES.md" "$stage/THIRD_PARTY_NOTICES.md"
if [[ "$distribution_mode" == 'unsigned-test' ]]; then
  printf '%s\n' \
    'UNSIGNED TEST ARTIFACT — ad-hoc signed, not notarized, and not release-ready.' \
    'Do not publish or redistribute this archive as a Kaigen release.' \
    > "$stage/UNSIGNED-TEST.txt"
elif [[ "$distribution_mode" == 'adhoc-release' ]]; then
  printf '%s\n' \
    'AD-HOC SIGNED RELEASE — this package is not notarized by Apple.' \
    'Verify the published SHA-256 before following the Gatekeeper instructions in PORTABLE.txt.' \
    > "$stage/ADHOC-SIGNATURE.txt"
fi

dmg_root="$artifacts_dir/.kaigen-dmg-root"
rm -rf "$dmg_root"
mkdir -p "$dmg_root/Kaigen-portable"
ditto "$app" "$dmg_root/Kaigen-portable/Kaigen.app"
ditto "$stage/Kaigen-portable-data" "$dmg_root/Kaigen-portable/Kaigen-portable-data"
ln -s /Applications "$dmg_root/Applications"
install -m 0644 "$project_root/packaging/PORTABLE-MACOS.txt" "$dmg_root/READ-ME-FIRST.txt"
if [[ "$distribution_mode" == 'unsigned-test' ]]; then
  install -m 0644 "$stage/UNSIGNED-TEST.txt" "$dmg_root/UNSIGNED-TEST.txt"
elif [[ "$distribution_mode" == 'adhoc-release' ]]; then
  install -m 0644 "$stage/ADHOC-SIGNATURE.txt" "$dmg_root/ADHOC-SIGNATURE.txt"
fi
dmg="$stage/$artifact_name.dmg"
rm -f "$dmg"
hdiutil create -quiet -volname "$dmg_volume_name" -srcfolder "$dmg_root" -ov -format UDZO "$dmg"
rm -rf "$dmg_root"
hdiutil verify "$dmg"
if [[ "$identity" != '-' ]]; then
  codesign --force --timestamp --sign "$identity" "$dmg"
  codesign --verify --verbose=2 "$dmg"
fi
if [[ -n "$notary_profile" ]]; then
  xcrun notarytool submit "$dmg" --keychain-profile "$notary_profile" --wait
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
fi

if find "$stage/Kaigen-portable-data" -type f \( -name '*.tox' -o -name '*.db' \) -print -quit | grep -q .; then
  echo "Private profile or database found in portable stage" >&2
  exit 1
fi

archive="$artifacts_dir/$artifact_name.zip"
rm -f "$archive"
(
  cd "$artifacts_dir"
  ditto -c -k --sequesterRsrc --keepParent "$(basename "$stage")" "$(basename "$archive")"
)
echo "macOS portable archive: $archive"
shasum -a 256 "$archive"

write_source_byte_manifest "$source_manifest_after"
if ! cmp -s "$source_manifest_before" "$source_manifest_after"; then
  echo "Source files changed during macOS packaging:" >&2
  diff -u "$source_manifest_before" "$source_manifest_after" >&2 || true
  exit 1
fi
cleanup_source_manifests
trap - EXIT
