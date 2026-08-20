#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd -P)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/kaigen-appimage-cache-test.XXXXXX")"

cleanup() {
  case "$test_root" in
    "${TMPDIR:-/tmp}"/kaigen-appimage-cache-test.*)
      find "$test_root" -type d -name tauri -exec chmod u+w {} + 2>/dev/null || true
      rm -rf -- "$test_root"
      ;;
    *) echo "Refusing to clean unsafe AppImage cache test path: $test_root" >&2; exit 1 ;;
  esac
}
trap cleanup EXIT

mkdir -p "$test_root/artifacts" "$test_root/downloads" "$test_root/expected" "$test_root/fake-bin"
set -- "$test_root/artifacts"
export KAIGEN_BUILD_APPIMAGE_FUNCTIONS_ONLY=1
source "$project_root/scripts/build-appimage.sh"
unset KAIGEN_BUILD_APPIMAGE_FUNCTIONS_ONLY
export KAIGEN_TOOL_CACHE_TEST_IGNORE_EXECUTABLE=1

if (require_pinned_size component-update-required "fixture unpinned tool" >/dev/null 2>&1); then
  echo "Unreviewed AppImage tool size pin was accepted" >&2
  exit 1
fi

cat > "$test_root/fake-bin/readelf" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ $# == 2 && $1 == -h ]]
grep -Fxq 'fixture-appimagetool-elf' "$2"
EOF
chmod 0755 "$test_root/fake-bin/readelf"

appimagetool_layout_root="$test_root/appimagetool-layout"
mkdir -p \
  "$appimagetool_layout_root/actual/usr/bin" \
  "$appimagetool_layout_root/actual/appimagetool-prefix/usr/bin"
printf '#!/usr/bin/env bash\nexit 0\n' > "$appimagetool_layout_root/actual/usr/bin/appimagetool"
printf 'fixture-appimagetool-elf\n' > "$appimagetool_layout_root/actual/appimagetool-prefix/usr/bin/appimagetool"
chmod 0755 \
  "$appimagetool_layout_root/actual/usr/bin/appimagetool" \
  "$appimagetool_layout_root/actual/appimagetool-prefix/usr/bin/appimagetool"
saved_appimagetool_sha256="$appimagetool_sha256"
appimagetool_sha256="$(sha256_of "$appimagetool_layout_root/actual/appimagetool-prefix/usr/bin/appimagetool")"
saved_path="$PATH"
PATH="$test_root/fake-bin:$PATH"
verify_pinned_appimagetool_layout "$appimagetool_layout_root/actual"
if [[ "$appimagetool_wrapper" != "$appimagetool_layout_root/actual/usr/bin/appimagetool" ||
      "$appimagetool_real" != "$appimagetool_layout_root/actual/appimagetool-prefix/usr/bin/appimagetool" ]]; then
  echo "Pinned appimagetool layout resolver did not select the actual extracted hierarchy" >&2
  exit 1
fi

expect_appimagetool_layout_failure() {
  local fixture_root="$1"
  local failure_message="$2"
  if (verify_pinned_appimagetool_layout "$fixture_root" >/dev/null 2>&1); then
    echo "$failure_message" >&2
    exit 1
  fi
}

mkdir -p \
  "$appimagetool_layout_root/wrong-hierarchy/usr/bin/appimagetool-prefix/usr/bin"
cp "$appimagetool_layout_root/actual/usr/bin/appimagetool" \
  "$appimagetool_layout_root/wrong-hierarchy/usr/bin/appimagetool"
cp "$appimagetool_layout_root/actual/appimagetool-prefix/usr/bin/appimagetool" \
  "$appimagetool_layout_root/wrong-hierarchy/usr/bin/appimagetool-prefix/usr/bin/appimagetool"
expect_appimagetool_layout_failure \
  "$appimagetool_layout_root/wrong-hierarchy" \
  "Obsolete nested appimagetool hierarchy was accepted"

mkdir -p \
  "$appimagetool_layout_root/symlink-wrapper/usr/bin" \
  "$appimagetool_layout_root/symlink-wrapper/appimagetool-prefix/usr/bin"
MSYS=winsymlinks:sys ln -s "$appimagetool_layout_root/actual/usr/bin/appimagetool" \
  "$appimagetool_layout_root/symlink-wrapper/usr/bin/appimagetool"
cp "$appimagetool_layout_root/actual/appimagetool-prefix/usr/bin/appimagetool" \
  "$appimagetool_layout_root/symlink-wrapper/appimagetool-prefix/usr/bin/appimagetool"
expect_appimagetool_layout_failure \
  "$appimagetool_layout_root/symlink-wrapper" \
  "Symlinked appimagetool wrapper was accepted"

appimagetool_sha256='0000000000000000000000000000000000000000000000000000000000000000'
expect_appimagetool_layout_failure \
  "$appimagetool_layout_root/actual" \
  "Mismatched appimagetool ELF hash was accepted"

mkdir -p \
  "$appimagetool_layout_root/not-elf/usr/bin" \
  "$appimagetool_layout_root/not-elf/appimagetool-prefix/usr/bin"
cp "$appimagetool_layout_root/actual/usr/bin/appimagetool" \
  "$appimagetool_layout_root/not-elf/usr/bin/appimagetool"
printf 'fixture-not-an-elf\n' > "$appimagetool_layout_root/not-elf/appimagetool-prefix/usr/bin/appimagetool"
chmod 0755 "$appimagetool_layout_root/not-elf/appimagetool-prefix/usr/bin/appimagetool"
appimagetool_sha256="$(sha256_of "$appimagetool_layout_root/not-elf/appimagetool-prefix/usr/bin/appimagetool")"
expect_appimagetool_layout_failure \
  "$appimagetool_layout_root/not-elf" \
  "Non-ELF appimagetool payload was accepted"
appimagetool_sha256="$saved_appimagetool_sha256"
PATH="$saved_path"

gdk_guard_root="$test_root/gdk-guard"
mkdir -p "$gdk_guard_root"
cat > "$gdk_guard_root/official-commented" <<'EOF'
export GDK_BACKEND=x11 # Crash with Wayland backend on Wayland - We tested it without it and ended up with this: https://github.com/tauri-apps/tauri/issues/8541
EOF
if [[ "$(count_known_gdk_x11_assignment_lines "$gdk_guard_root/official-commented")" != 1 ]]; then
  echo "Official commented GDK_BACKEND=x11 assignment was rejected" >&2
  exit 1
fi
printf 'export GTK_THEME=Adwaita\n' > "$gdk_guard_root/missing"
if [[ "$(count_known_gdk_x11_assignment_lines "$gdk_guard_root/missing")" != 0 ]]; then
  echo "Missing GDK_BACKEND=x11 assignment was accepted" >&2
  exit 1
fi
cat > "$gdk_guard_root/duplicate" <<'EOF'
export GDK_BACKEND=x11
  export   GDK_BACKEND=x11   # duplicate
EOF
if [[ "$(count_known_gdk_x11_assignment_lines "$gdk_guard_root/duplicate")" != 2 ]]; then
  echo "Duplicate GDK_BACKEND=x11 assignments were not detected" >&2
  exit 1
fi
cat > "$gdk_guard_root/arbitrary-suffix" <<'EOF'
export GDK_BACKEND=x11; echo unsafe
export GDK_BACKEND=x11 trailing
export GDK_BACKEND=x11#not-a-shell-comment
EOF
if [[ "$(count_known_gdk_x11_assignment_lines "$gdk_guard_root/arbitrary-suffix")" != 0 ]]; then
  echo "Arbitrary GDK_BACKEND=x11 assignment suffix was accepted" >&2
  exit 1
fi

cat > "$test_root/fake-bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
output=''
url=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --proto|--retry|--retry-delay) shift 2 ;;
    --tlsv1.2|--fail|--location|--retry-all-errors) shift ;;
    https://*) url="$1"; shift ;;
    *) echo "Unexpected fake curl argument: $1" >&2; exit 2 ;;
  esac
done
if [[ ${KAIGEN_FAKE_CURL_MODE:-normal} == fail ]]; then
  echo "Fixture curl must not run while exact canonical local tools are reusable" >&2
  exit 91
fi
if [[ -z "$output" || -z "$url" ]]; then
  echo "Fixture curl did not receive output and HTTPS URL" >&2
  exit 2
fi
cp "$KAIGEN_FAKE_CURL_ROOT/${url##*/}" "$output"
chmod 0644 "$output"
if [[ ${KAIGEN_FAKE_CURL_MODE:-normal} == corrupt &&
      ( -z ${KAIGEN_FAKE_CURL_CORRUPT_NAME-} || ${url##*/} == "$KAIGEN_FAKE_CURL_CORRUPT_NAME" ) ]]; then
  printf 'corrupt' >> "$output"
fi
EOF
chmod 0755 "$test_root/fake-bin/curl"

tool_names=(
  linuxdeploy-x86_64.AppImage
  AppRun-x86_64
  linuxdeploy-plugin-appimage.AppImage
  linuxdeploy-plugin-gstreamer.sh
  linuxdeploy-plugin-gtk.sh
  runtime-x86_64
)
for tool_name in "${tool_names[@]}"; do
  printf 'fixture:%s:0123456789abcdef\n' "$tool_name" > "$test_root/downloads/$tool_name"
  cp "$test_root/downloads/$tool_name" "$test_root/expected/$tool_name"
done
printf '\0\0\0' | dd \
  of="$test_root/expected/linuxdeploy-x86_64.AppImage" \
  bs=1 seek=8 count=3 conv=notrunc status=none
if [[ "$(sha256_of "$test_root/downloads/linuxdeploy-x86_64.AppImage")" == \
      "$(sha256_of "$test_root/expected/linuxdeploy-x86_64.AppImage")" ]]; then
  echo "Linuxdeploy fixture did not exercise Tauri's three-byte header transform" >&2
  exit 1
fi
chmod 0555 "$test_root/downloads"/* "$test_root/expected"/*

pinned_tauri_tool_specs=(
  "linuxdeploy-x86_64.AppImage|$(sha256_of "$test_root/expected/linuxdeploy-x86_64.AppImage")|$(stat -c %s "$test_root/expected/linuxdeploy-x86_64.AppImage")|fixture linuxdeploy|https://fixture.invalid/linuxdeploy-x86_64.AppImage|zero-linuxdeploy-header"
  "AppRun-x86_64|$(sha256_of "$test_root/expected/AppRun-x86_64")|$(stat -c %s "$test_root/expected/AppRun-x86_64")|fixture AppRun|https://fixture.invalid/AppRun-x86_64|none"
  "linuxdeploy-plugin-appimage.AppImage|$(sha256_of "$test_root/expected/linuxdeploy-plugin-appimage.AppImage")|$(stat -c %s "$test_root/expected/linuxdeploy-plugin-appimage.AppImage")|fixture AppImage plugin|https://fixture.invalid/linuxdeploy-plugin-appimage.AppImage|none"
  "linuxdeploy-plugin-gstreamer.sh|$(sha256_of "$test_root/expected/linuxdeploy-plugin-gstreamer.sh")|$(stat -c %s "$test_root/expected/linuxdeploy-plugin-gstreamer.sh")|fixture GStreamer plugin|https://fixture.invalid/linuxdeploy-plugin-gstreamer.sh|none"
  "linuxdeploy-plugin-gtk.sh|$(sha256_of "$test_root/expected/linuxdeploy-plugin-gtk.sh")|$(stat -c %s "$test_root/expected/linuxdeploy-plugin-gtk.sh")|fixture GTK plugin|https://fixture.invalid/linuxdeploy-plugin-gtk.sh|none"
  "runtime-x86_64|$(sha256_of "$test_root/expected/runtime-x86_64")|$(stat -c %s "$test_root/expected/runtime-x86_64")|fixture AppImage runtime|https://fixture.invalid/runtime-x86_64|none"
)

runtime_guard_root="$test_root/runtime-guard"
mkdir -p "$runtime_guard_root"
printf 'fixture-pinned-runtime-payload\n' > "$runtime_guard_root/pinned"
dd if="$runtime_guard_root/pinned" of="$runtime_guard_root/transformed" status=none
appimage_runtime_digest_md5_offset=8
appimage_runtime_digest_md5_length=4
printf 'MD5!' | dd \
  of="$runtime_guard_root/transformed" \
  bs=1 seek="$appimage_runtime_digest_md5_offset" count="$appimage_runtime_digest_md5_length" \
  conv=notrunc status=none
if cmp -s "$runtime_guard_root/pinned" "$runtime_guard_root/transformed"; then
  echo "Runtime fixture did not create an appimagetool digest delta" >&2
  exit 1
fi
normalize_appimage_runtime_prefix \
  "$runtime_guard_root/transformed" \
  "$runtime_guard_root/pinned" \
  "$runtime_guard_root/normalized"
if ! cmp -s "$runtime_guard_root/pinned" "$runtime_guard_root/normalized"; then
  echo "Runtime normalization did not restore the pinned prefix" >&2
  exit 1
fi
dd if="$runtime_guard_root/transformed" of="$runtime_guard_root/outside-delta" status=none
printf 'X' | dd of="$runtime_guard_root/outside-delta" bs=1 seek=2 count=1 conv=notrunc status=none
normalize_appimage_runtime_prefix \
  "$runtime_guard_root/outside-delta" \
  "$runtime_guard_root/pinned" \
  "$runtime_guard_root/outside-normalized"
if cmp -s "$runtime_guard_root/pinned" "$runtime_guard_root/outside-normalized"; then
  echo "Runtime normalization accepted a change outside .digest_md5" >&2
  exit 1
fi

run_prepare_case() {
  local name="$1"
  local component_root="$2"
  local allow_network="$3"
  local curl_mode="$4"
  (
    export KAIGEN_COMPONENT_CACHE_ROOT="$component_root"
    export KAIGEN_ALLOW_NETWORK_COMPONENT_FETCH="$allow_network"
    if [[ "$allow_network" == 1 ]]; then
      export KAIGEN_COMPONENT_UPDATE_SCOPE=all-managed-components
    else
      unset KAIGEN_COMPONENT_UPDATE_SCOPE || true
    fi
    export PATH="$test_root/fake-bin:$PATH"
    export KAIGEN_FAKE_CURL_ROOT="$test_root/downloads"
    export KAIGEN_FAKE_CURL_MODE="$curl_mode"
    tauri_cache_sandbox=''
    tauri_cache_root=''
    prepare_pinned_tauri_cache
    verify_pinned_tauri_cache "$tauri_cache_root" exact
    if [[ ${LDAI_RUNTIME_FILE-} != "$tauri_cache_root/runtime-x86_64" ]]; then
      echo "Pinned AppImage runtime was not exported through LDAI_RUNTIME_FILE" >&2
      exit 1
    fi
    cmp -s "$test_root/expected/runtime-x86_64" "$LDAI_RUNTIME_FILE"
    for tool_name in "${tool_names[@]}"; do
      cmp -s "$test_root/expected/$tool_name" "$tauri_cache_root/$tool_name"
    done
    printf '%s\n' "$tauri_cache_root" > "$test_root/$name.cache-path"
  )
}

reuse_global="$test_root/canonical-reuse"
mkdir -p "$reuse_global"
for tool_name in "${tool_names[@]}"; do
  install -m 0555 "$test_root/expected/$tool_name" "$reuse_global/$tool_name"
done
run_prepare_case reuse "$reuse_global" 0 fail

missing_global="$test_root/canonical-missing"
mkdir -p "$missing_global"
if (
  export KAIGEN_COMPONENT_CACHE_ROOT="$missing_global"
  export KAIGEN_ALLOW_NETWORK_COMPONENT_FETCH=0
  export PATH="$test_root/fake-bin:$PATH"
  export KAIGEN_FAKE_CURL_MODE=fail
  prepare_pinned_tauri_cache
); then
  echo "Missing canonical cache was accepted without the explicit component-update gate" >&2
  exit 1
fi
if find "$missing_global" -mindepth 1 -print -quit | grep -q .; then
  echo "Offline missing-cache rejection mutated the canonical component cache" >&2
  exit 1
fi
if (
  export KAIGEN_COMPONENT_CACHE_ROOT="$missing_global"
  export KAIGEN_ALLOW_NETWORK_COMPONENT_FETCH=1
  unset KAIGEN_COMPONENT_UPDATE_SCOPE || true
  export PATH="$test_root/fake-bin:$PATH"
  export KAIGEN_FAKE_CURL_MODE=fail
  prepare_pinned_tauri_cache
); then
  echo "Network fetch gate was accepted without the all-managed-components scope" >&2
  exit 1
fi
run_prepare_case update-missing "$missing_global" 1 normal
for tool_name in "${tool_names[@]}"; do
  expected_sha="$(sha256_of "$test_root/expected/$tool_name")"
  expected_upper="$(printf '%s' "$expected_sha" | tr '[:lower:]' '[:upper:]')"
  cmp -s "$test_root/expected/$tool_name" "$missing_global/$expected_upper/$tool_name"
done

mismatch_global="$test_root/canonical-mismatch"
mkdir -p "$mismatch_global"
for tool_name in "${tool_names[@]}"; do
  printf 'canonical-mismatch:%s\n' "$tool_name" > "$mismatch_global/$tool_name"
  chmod 0555 "$mismatch_global/$tool_name"
done
mismatch_before="$(find "$mismatch_global" -type f -print0 | sort -z | xargs -0 sha256sum)"
if (
  export KAIGEN_COMPONENT_CACHE_ROOT="$mismatch_global"
  export KAIGEN_ALLOW_NETWORK_COMPONENT_FETCH=1
  export KAIGEN_COMPONENT_UPDATE_SCOPE=all-managed-components
  export PATH="$test_root/fake-bin:$PATH"
  export KAIGEN_FAKE_CURL_MODE=normal
  prepare_pinned_tauri_cache
); then
  echo "Mismatched canonical component cache was silently replaced" >&2
  exit 1
fi
mismatch_after="$(find "$mismatch_global" -type f -print0 | sort -z | xargs -0 sha256sum)"
if [[ "$mismatch_before" != "$mismatch_after" ]]; then
  echo "Mismatch rejection mutated the canonical component cache" >&2
  exit 1
fi

corrupt_global="$test_root/canonical-corrupt-download"
mkdir -p "$corrupt_global"
if (
  export KAIGEN_COMPONENT_CACHE_ROOT="$corrupt_global"
  export KAIGEN_ALLOW_NETWORK_COMPONENT_FETCH=1
  export KAIGEN_COMPONENT_UPDATE_SCOPE=all-managed-components
  export PATH="$test_root/fake-bin:$PATH"
  export KAIGEN_FAKE_CURL_ROOT="$test_root/downloads"
  export KAIGEN_FAKE_CURL_MODE=corrupt
  export KAIGEN_FAKE_CURL_CORRUPT_NAME=runtime-x86_64
  tauri_cache_sandbox=''
  tauri_cache_root=''
  prepare_pinned_tauri_cache
); then
  echo "Corrupt downloaded AppImage runtime was accepted" >&2
  exit 1
fi
if find "$corrupt_global" -mindepth 1 -print -quit | grep -q .; then
  echo "Failed full component-update transaction partially mutated the canonical component cache" >&2
  exit 1
fi

echo "Pinned AppImage tool/runtime canonical-cache reuse, offline rejection, update-only fetch, LDAI selection, digest normalization, immutability, and hash-failure contracts passed."
