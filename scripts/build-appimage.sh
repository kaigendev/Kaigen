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

if [[ ${KAIGEN_BUILD_APPIMAGE_FUNCTIONS_ONLY-} != 1 ]]; then
  for command in awk cargo chmod cmp dd diff dirname find grep install mktemp mkdir mv npm readelf readlink rm sha256sum sort stat tr zip; do
    if ! command -v "$command" >/dev/null 2>&1; then
      echo "Required command is missing: $command" >&2
      exit 1
    fi
  done
  if [[ ${KAIGEN_ALLOW_NETWORK_COMPONENT_FETCH:-0} == 1 ]] && ! command -v curl >/dev/null 2>&1; then
    echo "Explicit component update requires curl" >&2
    exit 1
  fi
fi

app_run_template="$project_root/packaging/AppRun-linux.sh"
app_run_marker='KAIGEN_APPRUN_BACKEND_POLICY_V1'
linuxdeploy_sha256='20eebde3c18ae2e44279bd624fc72482503aece216d5d77f10932235342f71c1'
linuxdeploy_size='13264064'
app_run_runtime_sha256='f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f'
app_run_runtime_size='31552'
appimage_plugin_sha256='a45d3e227bc7f397e9cf6bfa4c9507494efa2293357b6e86690a3de2ca992e79'
appimage_plugin_size='16484856'
gstreamer_plugin_sha256='c107b49d84edbffc6ab226ed1007e0626a4f7aa2c3a36b7782bef62351d49e94'
gstreamer_plugin_size='4857'
gtk_plugin_sha256='cb379f9b0733e9ad9f8bd78f8c2fa038aef2478523bb7d4c8e64ff6a1ea3501a'
gtk_plugin_size='11648'
appimagetool_sha256='58d3047a420e1dfa365ef0ad495b728b56627803cb6b75ed816b7a4fa9713720'
appimage_runtime_sha256='1cc49bcf1e2ccd593c379adb17c9f85a36d619088296504de95b1d06215aebbf'
appimage_runtime_size='944632'
appimage_runtime_digest_md5_offset='932096'
appimage_runtime_digest_md5_length='16'
appimage_runtime_digest_md5_layout='0e3900:000010'
pinned_tauri_tool_specs=(
  "linuxdeploy-x86_64.AppImage|$linuxdeploy_sha256|$linuxdeploy_size|linuxdeploy|https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy/linuxdeploy-x86_64.AppImage|zero-linuxdeploy-header"
  "AppRun-x86_64|$app_run_runtime_sha256|$app_run_runtime_size|linuxdeploy AppRun runtime|https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-x86_64|none"
  "linuxdeploy-plugin-appimage.AppImage|$appimage_plugin_sha256|$appimage_plugin_size|AppImage plugin|https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-x86_64.AppImage|none"
  "linuxdeploy-plugin-gstreamer.sh|$gstreamer_plugin_sha256|$gstreamer_plugin_size|GStreamer plugin|https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gstreamer/2a2e67491c32995a3f279ad0ecbe77abd512b42a/linuxdeploy-plugin-gstreamer.sh|none"
  "linuxdeploy-plugin-gtk.sh|$gtk_plugin_sha256|$gtk_plugin_size|GTK plugin|https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/b5eb8d05b4c0ed40107fe2158c5d8527f94568ef/linuxdeploy-plugin-gtk.sh|none"
  "runtime-x86_64|$appimage_runtime_sha256|$appimage_runtime_size|AppImage type-2 runtime|https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64|none"
)

count_exact_line() {
  local expected="$1"
  local source_file="$2"
  grep -Fxc -- "$expected" "$source_file" || true
}

count_known_gdk_x11_assignment_lines() {
  local source_file="$1"
  grep -Ec '^[[:space:]]*export[[:space:]]+GDK_BACKEND=x11([[:space:]]+#[[:print:][:space:]]*)?[[:space:]]*$' "$source_file" || true
}

sha256_of() {
  sha256sum "$1" | awk '{print $1}'
}

require_sha256() {
  local source_file="$1"
  local expected="$2"
  local description="$3"
  local actual
  actual="$(sha256_of "$source_file")"
  if [[ "$actual" != "$expected" ]]; then
    echo "$description SHA-256 mismatch: expected $expected, got $actual" >&2
    exit 1
  fi
}

require_pinned_size() {
  local expected_size="$1"
  local description="$2"
  if [[ ! "$expected_size" =~ ^[1-9][0-9]*$ ]]; then
    echo "$description has no reviewed exact size pin; run only the explicit full Kaigen component-update route before any Debian build." >&2
    exit 1
  fi
}

verify_pinned_appimagetool_layout() {
  local plugin_appdir="$1"
  appimagetool_wrapper="$plugin_appdir/usr/bin/appimagetool"
  appimagetool_real="$plugin_appdir/appimagetool-prefix/usr/bin/appimagetool"
  if [[ ! -f "$appimagetool_wrapper" || -L "$appimagetool_wrapper" ]] || ! is_pinned_tool_executable "$appimagetool_wrapper"; then
    echo "Pinned plugin contains no safe executable appimagetool wrapper" >&2
    exit 1
  fi
  if [[ ! -f "$appimagetool_real" || -L "$appimagetool_real" ]] || ! is_pinned_tool_executable "$appimagetool_real"; then
    echo "Pinned plugin contains no safe executable appimagetool ELF" >&2
    exit 1
  fi
  require_sha256 "$appimagetool_real" "$appimagetool_sha256" "Pinned appimagetool"
  if ! readelf -h "$appimagetool_real" >/dev/null; then
    echo "Pinned appimagetool is not a valid ELF executable" >&2
    exit 1
  fi
}

verify_pinned_tauri_cache() {
  local cache_root="$1"
  local require_exact_entries="${2:-no}"
  local spec file_name expected expected_size description source_url transform tool_path actual_size
  for spec in "${pinned_tauri_tool_specs[@]}"; do
    IFS='|' read -r file_name expected expected_size description source_url transform <<<"$spec"
    require_pinned_size "$expected_size" "Pinned Tauri $description"
    tool_path="$cache_root/$file_name"
    if [[ ! -f "$tool_path" || -L "$tool_path" ]] || ! is_pinned_tool_executable "$tool_path"; then
      echo "Pinned Tauri $description is missing or unsafe: $tool_path" >&2
      exit 1
    fi
    actual_size="$(stat -c %s "$tool_path")"
    if [[ "$actual_size" != "$expected_size" ]]; then
      echo "Pinned Tauri $description size mismatch: expected $expected_size, got $actual_size" >&2
      exit 1
    fi
    require_sha256 "$tool_path" "$expected" "Pinned Tauri $description"
  done
  if [[ "$require_exact_entries" == exact ]]; then
    local cache_entry cache_name cache_entry_count=0
    while IFS= read -r -d '' cache_entry; do
      cache_name="${cache_entry##*/}"
      case "$cache_name" in
        linuxdeploy-x86_64.AppImage|AppRun-x86_64|linuxdeploy-plugin-appimage.AppImage|linuxdeploy-plugin-gstreamer.sh|linuxdeploy-plugin-gtk.sh|runtime-x86_64) ;;
        *) echo "Unexpected entry in isolated Tauri cache: $cache_entry" >&2; exit 1 ;;
      esac
      cache_entry_count=$((cache_entry_count + 1))
    done < <(find "$cache_root" -mindepth 1 -maxdepth 1 -print0)
    if [[ $cache_entry_count -ne ${#pinned_tauri_tool_specs[@]} ]]; then
      echo "Isolated Tauri cache must contain exactly ${#pinned_tauri_tool_specs[@]} pinned entries" >&2
      exit 1
    fi
  fi
}

is_pinned_tool_executable() {
  local source_file="$1"
  [[ -x "$source_file" ]] ||
    [[ ${kaigen_appimage_tool_cache_fixture_mode-} == 1 &&
       ${KAIGEN_TOOL_CACHE_TEST_IGNORE_EXECUTABLE-} == 1 ]]
}

is_exact_pinned_tool() {
  local source_file="$1"
  local expected="$2"
  local expected_size="$3"
  [[ -f "$source_file" && ! -L "$source_file" ]] &&
    is_pinned_tool_executable "$source_file" &&
    [[ "$(stat -c %s "$source_file")" == "$expected_size" ]] &&
    [[ "$(sha256_of "$source_file")" == "$expected" ]]
}

resolve_component_cache_root() {
  local requested_root="${KAIGEN_COMPONENT_CACHE_ROOT:-}"
  local allow_network="${KAIGEN_ALLOW_NETWORK_COMPONENT_FETCH:-0}"
  if [[ "$allow_network" != 0 && "$allow_network" != 1 ]]; then
    echo "KAIGEN_ALLOW_NETWORK_COMPONENT_FETCH must be exactly 0 or 1" >&2
    exit 2
  fi
  if [[ "$allow_network" == 1 && ${KAIGEN_COMPONENT_UPDATE_SCOPE:-} != all-managed-components ]]; then
    echo "Network component retrieval requires KAIGEN_COMPONENT_UPDATE_SCOPE=all-managed-components from the explicit full Kaigen component-update route." >&2
    exit 1
  fi
  if [[ -z "$requested_root" ]]; then
    echo "KAIGEN_COMPONENT_CACHE_ROOT must point to the canonical local component cache" >&2
    exit 1
  fi
  if [[ ! -d "$requested_root" ]]; then
    if [[ "$allow_network" == 1 ]]; then
      mkdir -p "$requested_root"
    else
      echo "Canonical local component cache was not found: $requested_root" >&2
      exit 1
    fi
  fi
  component_cache_root="$(cd "$requested_root" && pwd -P)"
}

component_cache_tool_path() {
  local file_name="$1" expected="$2" expected_upper candidate
  expected_upper="$(printf '%s' "$expected" | tr '[:lower:]' '[:upper:]')"
  for candidate in \
    "$component_cache_root/$file_name" \
    "$component_cache_root/$expected_upper/$file_name" \
    "$component_cache_root/$expected/$file_name"; do
    if [[ -e "$candidate" || -L "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  printf '%s/%s/%s\n' "$component_cache_root" "$expected_upper" "$file_name"
}

prepare_pinned_tauri_cache() {
  resolve_component_cache_root
  tauri_cache_sandbox="$(mktemp -d "$artifacts_dir/.kaigen-tauri-cache.XXXXXX")"
  tauri_cache_root="$tauri_cache_sandbox/tauri"
  mkdir -p "$tauri_cache_root"
  local spec file_name expected expected_size description source_url transform source_file destination download_file
  local -a pending_cache_files=()
  local -a pending_isolated_files=()
  for spec in "${pinned_tauri_tool_specs[@]}"; do
    IFS='|' read -r file_name expected expected_size description source_url transform <<<"$spec"
    require_pinned_size "$expected_size" "Pinned Tauri $description"
    source_file="$(component_cache_tool_path "$file_name" "$expected")"
    destination="$tauri_cache_root/$file_name"
    if [[ -e "$source_file" || -L "$source_file" ]]; then
      if ! is_exact_pinned_tool "$source_file" "$expected" "$expected_size"; then
        echo "Canonical local Tauri $description is invalid or unsafe: $source_file" >&2
        exit 1
      fi
      install -p -m 0555 "$source_file" "$destination"
      echo "Reused pinned Tauri $description from the canonical local component cache"
      continue
    fi

    if [[ ${KAIGEN_ALLOW_NETWORK_COMPONENT_FETCH:-0} != 1 ]]; then
      echo "Managed component is missing locally: $file_name. Expected $source_file. Network fallback is disabled outside the explicit Kaigen component-update route." >&2
      exit 1
    fi
    if [[ "$source_url" != https://* ]]; then
      echo "Refusing non-HTTPS Tauri tool URL: $source_url" >&2
      exit 1
    fi
    download_file="$tauri_cache_root/.$file_name.download"
    rm -f -- "$download_file"
    curl --proto '=https' --tlsv1.2 --fail --location --retry 4 --retry-all-errors --retry-delay 2 \
      --output "$download_file" "$source_url"
    case "$transform" in
      zero-linuxdeploy-header)
        printf '\0\0\0' | dd of="$download_file" bs=1 seek=8 count=3 conv=notrunc status=none
        ;;
      none) ;;
      *) echo "Unknown pinned Tauri tool transform: $transform" >&2; exit 1 ;;
    esac
    chmod 0555 "$download_file"
    if [[ "$(stat -c %s "$download_file")" != "$expected_size" ]]; then
      echo "Downloaded Tauri $description size mismatch: expected $expected_size, got $(stat -c %s "$download_file")" >&2
      exit 1
    fi
    require_sha256 "$download_file" "$expected" "Downloaded Tauri $description"
    mv -- "$download_file" "$destination"
    pending_cache_files+=("$source_file")
    pending_isolated_files+=("$destination")
    echo "Staged and verified pinned Tauri $description for the full component-update transaction"
  done
  verify_pinned_tauri_cache "$tauri_cache_root" exact
  local pending_index canonical_destination isolated_source promotion_temporary
  local -a promotion_temporaries=()
  for ((pending_index = 0; pending_index < ${#pending_cache_files[@]}; pending_index += 1)); do
    canonical_destination="${pending_cache_files[$pending_index]}"
    isolated_source="${pending_isolated_files[$pending_index]}"
    mkdir -p "$(dirname "$canonical_destination")"
    promotion_temporary="$canonical_destination.component-update.$$"
    rm -f -- "$promotion_temporary"
    install -p -m 0555 "$isolated_source" "$promotion_temporary"
    require_sha256 "$promotion_temporary" "$(sha256_of "$isolated_source")" "Staged canonical component"
    promotion_temporaries+=("$promotion_temporary")
  done
  for ((pending_index = 0; pending_index < ${#pending_cache_files[@]}; pending_index += 1)); do
    canonical_destination="${pending_cache_files[$pending_index]}"
    promotion_temporary="${promotion_temporaries[$pending_index]}"
    mv -- "$promotion_temporary" "$canonical_destination"
    echo "Updated canonical local component cache: $canonical_destination"
  done
  chmod 0555 "$tauri_cache_root"
  export XDG_CACHE_HOME="$tauri_cache_sandbox"
  export LDAI_RUNTIME_FILE="$tauri_cache_root/runtime-x86_64"
}

require_appimage_runtime_digest_layout() {
  local source_file="$1"
  local description="$2"
  local actual_layout
  actual_layout="$(LC_ALL=C readelf -SW "$source_file" | awk '$2 == ".digest_md5" { print $5 ":" $6 }')"
  if [[ "$actual_layout" != "$appimage_runtime_digest_md5_layout" ]]; then
    echo "$description has an unexpected .digest_md5 layout: expected $appimage_runtime_digest_md5_layout, got ${actual_layout:-missing}" >&2
    exit 1
  fi
}

normalize_appimage_runtime_prefix() {
  local source_prefix="$1"
  local pinned_runtime="$2"
  local destination="$3"
  local source_size pinned_size
  source_size="$(stat -c %s "$source_prefix")"
  pinned_size="$(stat -c %s "$pinned_runtime")"
  if [[ "$source_size" != "$pinned_size" ]]; then
    echo "Cannot normalize AppImage runtime prefixes with different sizes: $source_size != $pinned_size" >&2
    exit 1
  fi
  dd if="$source_prefix" of="$destination" status=none
  dd if="$pinned_runtime" of="$destination" \
    bs=1 \
    skip="$appimage_runtime_digest_md5_offset" \
    seek="$appimage_runtime_digest_md5_offset" \
    count="$appimage_runtime_digest_md5_length" \
    conv=notrunc \
    status=none
}

if [[ ${KAIGEN_BUILD_APPIMAGE_FUNCTIONS_ONLY-} == 1 ]]; then
  kaigen_appimage_tool_cache_fixture_mode=1
  return 0
fi

if [[ ! -f "$app_run_template" || -L "$app_run_template" ]]; then
  echo "Tracked Linux AppRun template must be a regular file: $app_run_template" >&2
  exit 1
fi
if [[ "$(count_exact_line "# $app_run_marker" "$app_run_template")" != 1 ]]; then
  echo "Tracked Linux AppRun template must contain exactly one $app_run_marker marker" >&2
  exit 1
fi

verify_kaigen_appdir() {
  local appdir="$1"
  local required
  for required in \
    AppRun \
    AppRun.wrapped \
    apprun-hooks/linuxdeploy-plugin-gtk.sh \
    usr/bin/Kaigen \
    usr/lib/libtoxcore.so.2 \
    usr/lib/Kaigen/libtoxcore.so \
    usr/lib/Kaigen/libtoxcore.so.2 \
    usr/lib/Kaigen/TorExpertBundle/tor/tor \
    usr/lib/Kaigen/TorExpertBundle/tor/pluggable_transports/lyrebird \
    usr/lib/libwebkit2gtk-4.1.so.0; do
    if [[ ! -e "$appdir/$required" ]]; then
      echo "AppImage is missing $required" >&2
      exit 1
    fi
  done
  if [[ ! -f "$appdir/AppRun" || -L "$appdir/AppRun" || ! -x "$appdir/AppRun" ]]; then
    echo "AppImage AppRun must be a regular executable file" >&2
    exit 1
  fi
  if [[ ! -f "$appdir/AppRun.wrapped" || -L "$appdir/AppRun.wrapped" || ! -x "$appdir/AppRun.wrapped" ]]; then
    echo "AppImage AppRun.wrapped must be a regular executable file" >&2
    exit 1
  fi
  local appdir_canonical app_run_canonical wrapped_canonical app_executable_canonical
  appdir_canonical="$(readlink -f "$appdir")"
  app_run_canonical="$(readlink -f "$appdir/AppRun")"
  wrapped_canonical="$(readlink -f "$appdir/AppRun.wrapped")"
  app_executable_canonical="$(readlink -f "$appdir/usr/bin/Kaigen")"
  case "$wrapped_canonical" in
    "$appdir_canonical"/*) ;;
    *) echo "AppImage AppRun.wrapped resolves outside AppDir: $wrapped_canonical" >&2; exit 1 ;;
  esac
  if [[ "$wrapped_canonical" == "$app_run_canonical" || "$wrapped_canonical" == "$app_executable_canonical" ]]; then
    echo "AppImage AppRun.wrapped has a recursive or ambiguous target" >&2
    exit 1
  fi
  require_sha256 "$appdir/AppRun.wrapped" "$app_run_runtime_sha256" "AppImage AppRun.wrapped"
  if ! readelf -h "$appdir/AppRun.wrapped" >/dev/null; then
    echo "AppImage AppRun.wrapped is not the expected ELF launcher" >&2
    exit 1
  fi
  if ! cmp -s "$app_run_template" "$appdir/AppRun"; then
    echo "AppImage AppRun does not match the tracked backend policy template" >&2
    exit 1
  fi
  if [[ "$(count_exact_line "# $app_run_marker" "$appdir/AppRun")" != 1 ]]; then
    echo "AppImage AppRun must contain exactly one $app_run_marker marker" >&2
    exit 1
  fi
  local -a desktop_files
  shopt -s nullglob
  desktop_files=("$appdir/usr/share/applications"/*.desktop)
  shopt -u nullglob
  if [[ ${#desktop_files[@]} -ne 1 || "${desktop_files[0]}" != "$appdir/usr/share/applications/Kaigen.desktop" ]]; then
    echo "AppImage must contain exactly one canonical Kaigen.desktop entry" >&2
    exit 1
  fi
  if [[ "$(count_exact_line 'Exec=Kaigen' "${desktop_files[0]}")" != 1 ]]; then
    echo "Kaigen.desktop must point the pinned AppRun.wrapped launcher to usr/bin/Kaigen" >&2
    exit 1
  fi
  if ! find "$appdir/usr/lib" -type f \( \
    -name 'libayatana-appindicator3.so*' -o \
    -name 'libappindicator3.so*' \
  \) -print -quit | grep -q .; then
    echo "AppImage is missing the AppIndicator runtime required by the Kaigen tray" >&2
    exit 1
  fi
  local app_executable="$appdir/usr/bin/Kaigen"
  if [[ ! -x "$app_executable" ]]; then
    echo "AppImage contains no executable Kaigen" >&2
    exit 1
  fi
  if ! readelf -h "$app_executable" >/dev/null; then
    echo "AppImage Kaigen is not a valid ELF executable" >&2
    exit 1
  fi
  local dynamic_section
  dynamic_section="$(readelf -d "$app_executable")"
  if ! grep -Fq 'Shared library: [libtoxcore.so.2]' <<<"$dynamic_section"; then
    echo "AppImage executable is not linked to the bundled toxcore soname" >&2
    exit 1
  fi
  if ! grep -Fq '$ORIGIN/../lib' <<<"$dynamic_section"; then
    echo "AppImage executable has no portable library rpath" >&2
    exit 1
  fi
}

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
        source_hash="$(printf '%s' "$(readlink "$source_path")" | sha256sum | awk '{print $1}')"
        printf 'L\t%s\t%s\n' "$source_hash" "$relative_path"
      else
        source_hash="$(sha256sum "$source_path" | awk '{print $1}')"
        printf 'F\t%s\t%s\n' "$source_hash" "$relative_path"
      fi
    done > "$destination"
}

source_manifest_before="$(mktemp "${TMPDIR:-/tmp}/kaigen-source-before.XXXXXX")"
source_manifest_after="$(mktemp "${TMPDIR:-/tmp}/kaigen-source-after.XXXXXX")"
repack_root=''
extract_dir=''
tauri_cache_sandbox=''
tauri_cache_root=''
cleanup_build_temporaries() {
  rm -f "$source_manifest_before" "$source_manifest_after"
  local temporary
  for temporary in "$repack_root" "$extract_dir" "$tauri_cache_sandbox"; do
    [[ -z "$temporary" ]] && continue
    case "$temporary" in
      "$artifacts_dir"/.kaigen-tauri-cache.*)
        if [[ -d "$temporary/tauri" ]]; then
          chmod u+w "$temporary/tauri"
        fi
        rm -rf -- "$temporary"
        ;;
      "$artifacts_dir"/.kaigen-appimage-repack.*|"$artifacts_dir"/.kaigen-appimage-check.*)
        rm -rf -- "$temporary"
        ;;
      *)
        echo "Refusing to clean unsafe AppImage temporary path: $temporary" >&2
        return 1
        ;;
    esac
  done
}
trap cleanup_build_temporaries EXIT
write_source_byte_manifest "$source_manifest_before"

bash "$project_root/scripts/test-apprun-linux.sh"
bash "$project_root/scripts/test-appimage-tool-cache.sh"

prepare_pinned_tauri_cache
verify_pinned_tauri_cache "$tauri_cache_root" exact
export NPM_CONFIG_OFFLINE=true
export CARGO_NET_OFFLINE=true
cd "$project_root"
npm ci --offline
cargo metadata --offline --locked --format-version 1 --manifest-path src-tauri/Cargo.toml >/dev/null

"$project_root/scripts/prepare-unix-dependencies.sh" linux

tox_lib_dir="$project_root/work/platform/linux/toxcore/lib"
tor_lib_dir="$project_root/work/platform/linux/TorExpertBundle/tor"
export KAIGEN_TOXCORE_LIB_DIR="$tox_lib_dir"
export LD_LIBRARY_PATH="$tox_lib_dir:$tor_lib_dir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

cd "$project_root"
cargo test --locked --manifest-path src-tauri/Cargo.toml
verify_pinned_tauri_cache "$tauri_cache_root" exact
npm run tauri -- build \
  --verbose \
  --config src-tauri/tauri.linux.conf.json \
  --bundles appimage
verify_pinned_tauri_cache "$tauri_cache_root" exact

write_source_byte_manifest "$source_manifest_after"
if ! cmp -s "$source_manifest_before" "$source_manifest_after"; then
  echo "Source files changed during the Debian build:" >&2
  diff -u "$source_manifest_before" "$source_manifest_after" >&2 || true
  exit 1
fi

appimage_dir="$project_root/src-tauri/target/release/bundle/appimage"
shopt -s nullglob
appimages=("$appimage_dir"/*.AppImage)
shopt -u nullglob
if [[ ${#appimages[@]} -ne 1 ]]; then
  echo "Expected exactly one Tauri AppImage, found ${#appimages[@]} in $appimage_dir" >&2
  printf '  %s\n' "${appimages[@]}" >&2
  exit 1
fi
appimage="${appimages[0]}"
if [[ ! -f "$appimage" || -L "$appimage" || ! -x "$appimage" ]]; then
  echo "Tauri AppImage must be a regular executable file: $appimage" >&2
  exit 1
fi

repack_root="$(mktemp -d "$artifacts_dir/.kaigen-appimage-repack.XXXXXX")"
runtime_offset="$appimage_runtime_size"
runtime_file="$tauri_cache_root/runtime-x86_64"
if [[ ! -f "$runtime_file" || -L "$runtime_file" || ! -x "$runtime_file" ]]; then
  echo "Pinned AppImage runtime is missing or unsafe: $runtime_file" >&2
  exit 1
fi
require_sha256 "$runtime_file" "$appimage_runtime_sha256" "Pinned AppImage runtime"
if [[ "$(stat -c %s "$runtime_file")" != "$runtime_offset" ]]; then
  echo "Pinned AppImage runtime size mismatch: expected $runtime_offset" >&2
  exit 1
fi
require_appimage_runtime_digest_layout "$runtime_file" "Pinned AppImage runtime"
require_appimage_runtime_digest_layout "$appimage" "Tauri AppImage runtime"
tauri_runtime_file="$repack_root/tauri-runtime-x86_64"
dd if="$appimage" of="$tauri_runtime_file" bs=1 count="$runtime_offset" status=none
if [[ "$(stat -c %s "$tauri_runtime_file")" != "$runtime_offset" ]]; then
  echo "Could not extract the complete Tauri AppImage runtime prefix" >&2
  exit 1
fi
if cmp -s "$runtime_file" "$tauri_runtime_file"; then
  echo "Tauri AppImage did not embed its expected .digest_md5 value" >&2
  exit 1
fi
tauri_runtime_transformed_sha256="$(sha256_of "$tauri_runtime_file")"
tauri_runtime_normalized="$repack_root/tauri-runtime-normalized-x86_64"
normalize_appimage_runtime_prefix "$tauri_runtime_file" "$runtime_file" "$tauri_runtime_normalized"
require_sha256 "$tauri_runtime_normalized" "$appimage_runtime_sha256" "Normalized Tauri AppImage runtime"
reported_runtime_offset="$("$appimage" --appimage-offset)"
if [[ "$reported_runtime_offset" != "$runtime_offset" ]]; then
  echo "Original AppImage runtime offset mismatch: expected $runtime_offset, got $reported_runtime_offset" >&2
  exit 1
fi

original_extract="$repack_root/original-extract"
mkdir -p "$original_extract"
(
  cd "$original_extract"
  "$appimage" --appimage-extract >/dev/null
)
original_appdir="$original_extract/squashfs-root"
generated_app_run="$original_appdir/AppRun"
generated_gtk_hook="$original_appdir/apprun-hooks/linuxdeploy-plugin-gtk.sh"
if [[ ! -f "$generated_app_run" || -L "$generated_app_run" || ! -x "$generated_app_run" ]]; then
  echo "Generated AppRun must be a regular executable file before repacking" >&2
  exit 1
fi
if [[ ! -f "$generated_gtk_hook" || -L "$generated_gtk_hook" ]]; then
  echo "Generated GTK AppRun hook must be a regular file before repacking" >&2
  exit 1
fi
if [[ "$(count_exact_line 'source "$this_dir"/apprun-hooks/"linuxdeploy-plugin-gtk.sh"' "$generated_app_run")" != 1 ]]; then
  echo "Generated AppRun must source exactly one known linuxdeploy GTK hook" >&2
  exit 1
fi
if [[ "$(count_exact_line 'exec "$this_dir"/AppRun.wrapped "$@"' "$generated_app_run")" != 1 ]]; then
  echo "Generated AppRun must exec exactly one AppRun.wrapped target" >&2
  exit 1
fi
if grep -Fq -- "$app_run_marker" "$generated_app_run"; then
  echo "Generated AppRun already contains the Kaigen policy marker; refusing recursive repack" >&2
  exit 1
fi
if [[ "$(count_known_gdk_x11_assignment_lines "$generated_gtk_hook")" != 1 ]]; then
  echo "Generated GTK hook no longer contains exactly one known GDK_BACKEND=x11 assignment" >&2
  exit 1
fi

install -p -m 0755 "$app_run_template" "$generated_app_run"
verify_kaigen_appdir "$original_appdir"

if [[ -z "$tauri_cache_root" || "$tauri_cache_root" != "$tauri_cache_sandbox/tauri" ]]; then
  echo "Pinned isolated Tauri cache was not prepared before the build" >&2
  exit 1
fi
appimage_plugin="$tauri_cache_root/linuxdeploy-plugin-appimage.AppImage"
if [[ ! -f "$appimage_plugin" || -L "$appimage_plugin" || ! -x "$appimage_plugin" ]]; then
  echo "Pinned Tauri AppImage plugin is missing or unsafe: $appimage_plugin" >&2
  exit 1
fi
require_sha256 "$appimage_plugin" "$appimage_plugin_sha256" "Tauri AppImage plugin"

plugin_extract="$repack_root/plugin-extract"
mkdir -p "$plugin_extract"
(
  cd "$plugin_extract"
  "$appimage_plugin" --appimage-extract >/dev/null
)
plugin_appdir="$plugin_extract/squashfs-root"
verify_pinned_appimagetool_layout "$plugin_appdir"

patched_appimage="$repack_root/Kaigen-patched-x86_64.AppImage"
ARCH=x86_64 "$appimagetool_wrapper" \
  --no-appstream \
  --comp zstd \
  --runtime-file "$runtime_file" \
  "$original_appdir" \
  "$patched_appimage"
if [[ ! -f "$patched_appimage" || -L "$patched_appimage" || ! -x "$patched_appimage" ]]; then
  echo "Pinned appimagetool did not produce an executable AppImage" >&2
  exit 1
fi
if ! readelf -h "$patched_appimage" >/dev/null; then
  echo "Repacked AppImage is not a valid ELF executable" >&2
  exit 1
fi
require_appimage_runtime_digest_layout "$patched_appimage" "Repacked AppImage runtime"
patched_runtime="$repack_root/patched-runtime-x86_64"
dd if="$patched_appimage" of="$patched_runtime" bs=1 count="$runtime_offset" status=none
if [[ "$(stat -c %s "$patched_runtime")" != "$runtime_offset" ]]; then
  echo "Could not extract the complete repacked AppImage runtime prefix" >&2
  exit 1
fi
if cmp -s "$runtime_file" "$patched_runtime"; then
  echo "Repacked AppImage did not embed its expected .digest_md5 value" >&2
  exit 1
fi
patched_runtime_transformed_sha256="$(sha256_of "$patched_runtime")"
patched_runtime_normalized="$repack_root/patched-runtime-normalized-x86_64"
normalize_appimage_runtime_prefix "$patched_runtime" "$runtime_file" "$patched_runtime_normalized"
require_sha256 "$patched_runtime_normalized" "$appimage_runtime_sha256" "Normalized repacked AppImage runtime"
if ! cmp -s "$tauri_runtime_normalized" "$patched_runtime_normalized"; then
  echo "Tauri and repacked AppImage runtime prefixes differ outside the allowed .digest_md5 section" >&2
  exit 1
fi
patched_offset="$("$patched_appimage" --appimage-offset)"
if [[ "$patched_offset" != "$runtime_offset" ]]; then
  echo "Repacked AppImage runtime offset changed: expected $runtime_offset, got $patched_offset" >&2
  exit 1
fi

patched_extract="$repack_root/patched-extract"
mkdir -p "$patched_extract"
(
  cd "$patched_extract"
  "$patched_appimage" --appimage-extract >/dev/null
)
verify_kaigen_appdir "$patched_extract/squashfs-root"

patched_device="$(stat -c %d "$patched_appimage")"
destination_device="$(stat -c %d "$appimage_dir")"
if [[ "$patched_device" != "$destination_device" ]]; then
  echo "Repacked AppImage and Tauri output are on different filesystems; atomic replacement is impossible" >&2
  exit 1
fi
echo "Pinned AppImage plugin SHA-256: $(sha256_of "$appimage_plugin")"
echo "Pinned appimagetool SHA-256: $(sha256_of "$appimagetool_real")"
echo "Pinned AppImage runtime SHA-256: $(sha256_of "$runtime_file")"
echo "Tauri transformed AppImage runtime SHA-256: $tauri_runtime_transformed_sha256"
echo "Repacked transformed AppImage runtime SHA-256: $patched_runtime_transformed_sha256"
echo "Repacked AppImage SHA-256: $(sha256_of "$patched_appimage")"
mv -f -- "$patched_appimage" "$appimage"

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

extract_dir="$(mktemp -d "$artifacts_dir/.kaigen-appimage-check.XXXXXX")"
(
  cd "$extract_dir"
  "$stage/Kaigen-x86_64.AppImage" --appimage-extract >/dev/null
)
appdir="$extract_dir/squashfs-root"
verify_kaigen_appdir "$appdir"

archive="$artifacts_dir/Kaigen-portable-debian-x64.zip"
rm -f "$archive"
(
  cd "$artifacts_dir"
  zip -9 -q -r "$(basename "$archive")" "$(basename "$stage")"
)
echo "Debian portable archive: $archive"
sha256sum "$archive"

write_source_byte_manifest "$source_manifest_after"
if ! cmp -s "$source_manifest_before" "$source_manifest_after"; then
  echo "Source files changed during Debian packaging:" >&2
  diff -u "$source_manifest_before" "$source_manifest_after" >&2 || true
  exit 1
fi
cleanup_build_temporaries
trap - EXIT
