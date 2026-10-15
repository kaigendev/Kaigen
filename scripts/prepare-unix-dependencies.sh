#!/usr/bin/env bash
set -euo pipefail

platform="${1:-}"
if [[ "$platform" != "linux" && "$platform" != "macos" ]]; then
  echo "usage: $0 <linux|macos>" >&2
  exit 2
fi

host="$(uname -s)"
if [[ "$platform" == "linux" && "$host" != "Linux" ]]; then
  echo "Linux dependencies must be built on Linux (found: $host)" >&2
  exit 1
fi
if [[ "$platform" == "macos" && "$host" != "Darwin" ]]; then
  echo "macOS dependencies must be built on macOS (found: $host)" >&2
  exit 1
fi
allow_network_component_fetch="${KAIGEN_ALLOW_NETWORK_COMPONENT_FETCH:-0}"
if [[ "$allow_network_component_fetch" != 0 && "$allow_network_component_fetch" != 1 ]]; then
  echo "KAIGEN_ALLOW_NETWORK_COMPONENT_FETCH must be exactly 0 or 1" >&2
  exit 2
fi
if [[ "$allow_network_component_fetch" == 1 && ${KAIGEN_COMPONENT_UPDATE_SCOPE:-} != all-managed-components ]]; then
  echo "Network component retrieval requires KAIGEN_COMPONENT_UPDATE_SCOPE=all-managed-components from the explicit full Kaigen component-update route." >&2
  exit 1
fi

for command in awk cp dirname mkdir mv rm stat tr unzip tar cmake ninja make git node; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is missing: $command" >&2
    exit 1
  fi
done
if [[ "$platform" == "macos" ]] && ! command -v lipo >/dev/null 2>&1; then
  echo "Required Xcode command is missing: lipo" >&2
  exit 1
fi
if [[ "$allow_network_component_fetch" == 1 ]] && ! command -v curl >/dev/null 2>&1; then
  echo "Explicit component update requires curl" >&2
  exit 1
fi

project_root="$(cd "$(dirname "$0")/.." && pwd)"
node "$project_root/scripts/verify-source-hygiene.mjs"
work_root="$project_root/work"
download_dir="$work_root/downloads"
source_dir="$work_root/platform-sources"
platform_dir="$work_root/platform/$platform"
jobs="${KAIGEN_BUILD_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)}"
component_cache_root="${KAIGEN_COMPONENT_CACHE_ROOT:-}"
if [[ -z "$component_cache_root" ]]; then
  echo "KAIGEN_COMPONENT_CACHE_ROOT must point to the canonical local component cache" >&2
  exit 1
fi
if [[ ! -d "$component_cache_root" ]]; then
  if [[ "$allow_network_component_fetch" == 1 ]]; then
    mkdir -p "$component_cache_root"
  else
    echo "Canonical local component cache was not found: $component_cache_root" >&2
    exit 1
  fi
fi
component_cache_root="$(cd "$component_cache_root" && pwd -P)"

toxcore_commit="ec7bd2cce618ed6542fbc55b84574704eb380ef2"
toxcore_url="https://codeload.github.com/kaigendev/kaigen-toxcore/zip/$toxcore_commit"
toxcore_sha="8aebf2e3ef3a4c1b3b4afb367e717307eea170e510a0dc53bf0536f57dda003e"
toxcore_size='1405890'
sodium_url="https://download.libsodium.org/libsodium/releases/libsodium-1.0.22-stable.tar.gz"
sodium_sha="eb9873cc5ccd7b26ef058394264663c99e9c047b423be1ffd484071774198f26"
sodium_size='2099899'
sodium_source_tree='a0dc564342df7f47f1fb728997dc33a6c5ad014744b7724469a2b5612d32957e'
tor_base="https://archive.torproject.org/tor-package-archive/torbrowser/15.0.25"

mkdir -p "$download_dir" "$source_dir" "$platform_dir"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print tolower($1)}'
  else
    shasum -a 256 "$1" | awk '{print tolower($1)}'
  fi
}

file_size() {
  if [[ "$host" == "Darwin" ]]; then
    stat -f %z "$1"
  else
    stat -c %s "$1"
  fi
}

assert_file_identity() {
  local source_file="$1" expected_size="$2" expected_sha="$3" description="$4"
  if [[ ! -f "$source_file" || -L "$source_file" ]]; then
    echo "$description is missing or unsafe: $source_file" >&2
    exit 1
  fi
  local actual_size actual_sha
  actual_size="$(file_size "$source_file")"
  if [[ "$actual_size" != "$expected_size" ]]; then
    echo "$description size mismatch: expected $expected_size, got $actual_size ($source_file)" >&2
    exit 1
  fi
  actual_sha="$(sha256_file "$source_file")"
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    echo "$description SHA-256 mismatch: expected $expected_sha, got $actual_sha ($source_file)" >&2
    exit 1
  fi
}

component_cache_path() {
  local file_name="$1" expected_sha="$2" expected_upper candidate
  expected_upper="$(printf '%s' "$expected_sha" | tr '[:lower:]' '[:upper:]')"
  for candidate in \
    "$component_cache_root/sha256/$expected_sha/$file_name" \
    "$component_cache_root/$file_name" \
    "$component_cache_root/$expected_upper/$file_name" \
    "$component_cache_root/$expected_sha/$file_name"; do
    if [[ -e "$candidate" || -L "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  printf '%s/%s/%s\n' "$component_cache_root" "$expected_upper" "$file_name"
}

download_verified() {
  local url="$1" destination="$2" expected_size="$3" expected_sha="$4"
  local file_name cache_path download_file
  file_name="${destination##*/}"
  if [[ -e "$destination" || -L "$destination" ]]; then
    if [[ -f "$destination" && ! -L "$destination" ]] && \
       [[ "$(file_size "$destination")" == "$expected_size" ]] && \
       [[ "$(sha256_file "$destination")" == "$expected_sha" ]]; then
      return
    fi
    if [[ "$allow_network_component_fetch" != 1 ]]; then
      echo "Local component copy is invalid and network fallback is disabled: $destination" >&2
      exit 1
    fi
    rm -f -- "$destination"
  fi

  cache_path="$(component_cache_path "$file_name" "$expected_sha")"
  if [[ -e "$cache_path" || -L "$cache_path" ]]; then
    assert_file_identity "$cache_path" "$expected_size" "$expected_sha" "Canonical local component"
    cp -p -- "$cache_path" "$destination"
    assert_file_identity "$destination" "$expected_size" "$expected_sha" "Materialized local component"
    echo "Using canonical local component: $cache_path"
    return
  fi

  if [[ "$allow_network_component_fetch" != 1 ]]; then
    echo "Managed component is missing locally: $file_name. Expected $cache_path. Network fallback is disabled outside the explicit Kaigen component-update route." >&2
    exit 1
  fi

  if [[ -z "$url" ]]; then
    echo "Derived managed component is missing from its canonical local cache: $file_name" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$cache_path")"
  download_file="$cache_path.download"
  rm -f -- "$download_file"
  curl --fail --location --retry 4 --retry-all-errors --retry-delay 2 --output "$download_file" "$url"
  assert_file_identity "$download_file" "$expected_size" "$expected_sha" "Downloaded component"
  mv -- "$download_file" "$cache_path"
  cp -p -- "$cache_path" "$destination"
  assert_file_identity "$destination" "$expected_size" "$expected_sha" "Materialized downloaded component"
  echo "Updated canonical local component cache: $cache_path"
}

tox_archive="$download_dir/kaigen-toxcore-$toxcore_commit.zip"
sodium_archive="$download_dir/libsodium-1.0.22-stable-20261013.tar.gz"
download_verified "$toxcore_url" "$tox_archive" "$toxcore_size" "$toxcore_sha"
download_verified "$sodium_url" "$sodium_archive" "$sodium_size" "$sodium_sha"

# Exact local conversion of the signed IPFire database; no hosted derived archive.
geoip_archive="$download_dir/geoip-ipfire-20261015.tar.gz"
geoip_sha="2681a63f6c09748df9fb1f98cedd616698421ca50c4abf10d16a81a1507c203b"
geoip_size="4689119"
geoip_v4_sha="9eefc7cbf75278deaf70b877e41761170cfee8fa81754bcf23ef9159262fd30f"
geoip_v4_size="9786103"
geoip_v6_sha="6c936fc6a1d655d92ca5b01da9f3e8d7246cb569e35bfcdc3c8645d495e5c2f4"
geoip_v6_size="16706218"
geoip_license_sha="28a9529c7d0bb4dc51f4bf5c116a3d16ef247a052f7591466768ddf563fd1cf5"
geoip_license_size="20138"
seed_verified_vendor_input() {
  local file_name="$1" expected_size="$2" expected_sha="$3" cache_path vendor_input
  cache_path="$(component_cache_path "$file_name" "$expected_sha")"
  if [[ -e "$cache_path" || -L "$cache_path" ]]; then
    assert_file_identity "$cache_path" "$expected_size" "$expected_sha" "Canonical local component"
    return
  fi
  vendor_input="$project_root/runtime-manifests/vendor-inputs/$file_name"
  if [[ ! -e "$vendor_input" && ! -L "$vendor_input" ]]; then return; fi
  assert_file_identity "$vendor_input" "$expected_size" "$expected_sha" "Tracked vendor input"
  mkdir -p "$(dirname "$cache_path")"
  cp -p -- "$vendor_input" "$cache_path"
  assert_file_identity "$cache_path" "$expected_size" "$expected_sha" "Seeded canonical component"
}

seed_verified_vendor_input "${geoip_archive##*/}" "$geoip_size" "$geoip_sha"
download_verified "" "$geoip_archive" "$geoip_size" "$geoip_sha"

apply_geoip_overlay() {
  local tor_bundle_dir="$1"
  mkdir -p "$tor_bundle_dir/data" "$tor_bundle_dir/docs"
  tar -xzf "$geoip_archive" -C "$tor_bundle_dir/data" geoip geoip6
  assert_file_identity "$tor_bundle_dir/data/geoip" "$geoip_v4_size" "$geoip_v4_sha" "Pinned Tor IPv4 GeoIP"
  assert_file_identity "$tor_bundle_dir/data/geoip6" "$geoip_v6_size" "$geoip_v6_sha" "Pinned Tor IPv6 GeoIP"
  tar -xOf "$geoip_archive" LICENSE-CC-BY-SA-4.0.txt > "$tor_bundle_dir/docs/geoip-ipfire-CC-BY-SA-4.0.txt.tmp"
  mv "$tor_bundle_dir/docs/geoip-ipfire-CC-BY-SA-4.0.txt.tmp" "$tor_bundle_dir/docs/geoip-ipfire-CC-BY-SA-4.0.txt"
  assert_file_identity "$tor_bundle_dir/docs/geoip-ipfire-CC-BY-SA-4.0.txt" "$geoip_license_size" "$geoip_license_sha" "GeoIP CC-BY-SA-4.0 license"
}

prepared_cache_root="${KAIGEN_PREPARED_NATIVE_CACHE_ROOT:-}"
prepared_cache_tool="$project_root/scripts/prepared-native-cache.mjs"
prepared_cache_platform='linux-x86_64'
if [[ "$platform" == macos ]]; then
  prepared_cache_platform='macos-universal'
fi
prepared_cache_contract_dir="$platform_dir/.prepared-native-contracts"
prepared_cache_receipt="$platform_dir/prepared-native-cache-receipt.jsonl"
prepared_cache_enabled=0
prepared_cache_mode="${KAIGEN_PREPARED_NATIVE_CACHE_MODE:-expected-hit}"
if [[ "$prepared_cache_mode" != expected-hit && "$prepared_cache_mode" != populate ]]; then
  echo "KAIGEN_PREPARED_NATIVE_CACHE_MODE must be expected-hit or populate" >&2
  exit 2
fi
if [[ -n "$prepared_cache_root" ]]; then
  if [[ ! -f "$prepared_cache_tool" || -L "$prepared_cache_tool" ]]; then
    echo "Prepared native cache tool is missing or unsafe: $prepared_cache_tool" >&2
    exit 1
  fi
  if [[ -e "$prepared_cache_root" || -L "$prepared_cache_root" ]]; then
    if [[ ! -d "$prepared_cache_root" || -L "$prepared_cache_root" ]]; then
      echo "Prepared native cache root is unsafe: $prepared_cache_root" >&2
      exit 1
    fi
  else
    mkdir -p "$prepared_cache_root"
  fi
  prepared_cache_root="$(cd "$prepared_cache_root" && pwd -P)"
  mkdir -p "$prepared_cache_contract_dir"
  : > "$prepared_cache_receipt"
  prepared_cache_enabled=1
fi

prepared_contract_path() {
  printf '%s/%s.tsv\n' "$prepared_cache_contract_dir" "$1"
}

write_prepared_contract() {
  local group="$1" contract
  contract="$(prepared_contract_path "$group")"
  node "$prepared_cache_tool" contract \
    --platform "$prepared_cache_platform" \
    --group "$group" \
    --project-root "$project_root" \
    --input-root "$download_dir" \
    --prepare-script "$project_root/scripts/prepare-unix-dependencies.sh" \
    --cache-tool "$prepared_cache_tool" \
    --output "$contract" >/dev/null
}

record_prepared_result() {
  local result="$1"
  printf '%s\n' "$result"
  printf '%s\n' "$result" >> "$prepared_cache_receipt"
}

restore_prepared_group() {
  local group="$1" destination="$2" contract output code
  if [[ "$prepared_cache_enabled" != 1 ]]; then
    return 10
  fi
  contract="$(prepared_contract_path "$group")"
  write_prepared_contract "$group"
  if output="$(node "$prepared_cache_tool" restore \
      --cache-root "$prepared_cache_root" \
      --contract "$contract" \
      --destination "$destination" 2>&1)"; then
    record_prepared_result "$output"
    return 0
  else
    code=$?
  fi
  if [[ "$code" == 10 ]]; then
    if [[ "$prepared_cache_mode" == expected-hit ]]; then
      printf 'Prepared native cache was required to hit before compilation: platform=%s group=%s\n%s\n' \
        "$prepared_cache_platform" "$group" "$output" >&2
      exit 1
    fi
    printf '%s\n' "$output"
    return 10
  fi
  printf '%s\n' "$output" >&2
  exit "$code"
}

promote_prepared_group() {
  local group="$1" source="$2" contract
  if [[ "$prepared_cache_enabled" != 1 ]]; then
    printf 'prepared-native-cache platform=%s group=%s disposition=built-uncached\n' \
      "$prepared_cache_platform" "$group"
    return
  fi
  contract="$(prepared_contract_path "$group")"
  if [[ ! -f "$contract" ]]; then
    write_prepared_contract "$group"
  fi
  local output
  output="$(node "$prepared_cache_tool" promote \
    --cache-root "$prepared_cache_root" \
    --contract "$contract" \
    --source "$source" \
    --producer-script "$project_root/scripts/prepare-unix-dependencies.sh" \
    --cache-tool "$prepared_cache_tool" \
    --mode compiled-miss)"
  record_prepared_result "$output"
}

sodium_prefix="$platform_dir/libsodium"
sodium_build="$platform_dir/libsodium-build"
if restore_prepared_group libsodium "$sodium_prefix"; then
  rm -rf "$sodium_build"
else
  sodium_source="$source_dir/libsodium-1.0.22-stable-20261013-$sodium_sha"
  if [[ -L "$sodium_source" || ( -e "$sodium_source" && ! -d "$sodium_source" ) ]]; then
    echo "Pinned libsodium source path is unsafe: $sodium_source" >&2
    exit 1
  fi
  if [[ ! -d "$sodium_source" ]]; then
    mkdir -p "$sodium_source"
    tar -xzf "$sodium_archive" -C "$sodium_source" --strip-components=1
  fi
  node --input-type=module - "$prepared_cache_tool" "$sodium_source" "$sodium_source_tree" <<'NODE'
import { pathToFileURL } from "node:url";
const { contentTreeSha256 } = await import(pathToFileURL(process.argv[2]));
const observed = await contentTreeSha256(process.argv[3]);
if (observed !== process.argv[4]) throw new Error(`Pinned libsodium source tree mismatch: ${observed}`);
NODE
  if [[ ! -x "$sodium_source/configure" ]]; then
    echo "Pinned libsodium source has no executable configure: $sodium_source" >&2
    exit 1
  fi
  rm -rf "$sodium_prefix" "$sodium_build"
  cp -R "$sodium_source" "$sodium_build"
  pushd "$sodium_build" >/dev/null
  if [[ "$platform" == "macos" ]]; then
    export CFLAGS="-O2 -fPIC -arch x86_64 -arch arm64 -mmacosx-version-min=12.0"
    export LDFLAGS="-arch x86_64 -arch arm64 -mmacosx-version-min=12.0"
  else
    # libsodium is linked into the portable shared libtoxcore.so.
    export CFLAGS="-O2 -fPIC"
  fi
  ./configure --prefix="$sodium_prefix" --disable-shared --enable-static --with-pic
  make -j"$jobs"
  make install
  popd >/dev/null
  promote_prepared_group libsodium "$sodium_prefix"
fi

tox_build="$platform_dir/toxcore-build"
tox_prefix="$platform_dir/toxcore"
if restore_prepared_group c-toxcore "$tox_prefix"; then
  rm -rf "$tox_build"
else
  tox_source="$source_dir/kaigen-toxcore-$toxcore_commit"
  rm -rf -- "$tox_source"
  unzip -q "$tox_archive" -d "$source_dir"
  if [[ ! -f "$tox_source/CMakeLists.txt" || ! -f "$tox_source/third_party/cmp/cmp.c" ]]; then
    echo "The pinned Kaigen toxcore archive has an unexpected layout." >&2
    exit 1
  fi

  rm -rf "$tox_build" "$tox_prefix"
  mkdir -p "$tox_build" "$tox_prefix/lib"
  export PKG_CONFIG_PATH="$sodium_prefix/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
  cmake_args=(
    -S "$tox_source"
    -B "$tox_build"
    -G Ninja
    -DCMAKE_BUILD_TYPE=Release
    -DBUILD_TOXAV=OFF
    -DBOOTSTRAP_DAEMON=OFF
    -DAUTOTEST=OFF
    -DBUILD_SHARED_LIBS=ON
    -DCMAKE_PREFIX_PATH="$sodium_prefix"
    -DCMAKE_INSTALL_PREFIX="$tox_prefix"
  )
  if [[ "$platform" == "macos" ]]; then
    cmake_args+=(
      '-DCMAKE_OSX_ARCHITECTURES=x86_64;arm64'
      -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0
      '-DCMAKE_INSTALL_NAME_DIR=@rpath'
    )
  fi
  cmake "${cmake_args[@]}"
  cmake --build "$tox_build" --target toxcore_shared -j "$jobs"

  if [[ "$platform" == "linux" ]]; then
    tox_library="$(find "$tox_build" -name 'libtoxcore.so' -print -quit)"
  else
    tox_library="$(find "$tox_build" -name 'libtoxcore.dylib' -print -quit)"
  fi
  if [[ -z "$tox_library" ]]; then
    echo "c-toxcore shared library was not produced" >&2
    exit 1
  fi
  if [[ "$platform" == "linux" ]]; then
    for tox_candidate in "$(dirname "$tox_library")"/libtoxcore.so*; do
      cp -L "$tox_candidate" "$tox_prefix/lib/$(basename "$tox_candidate")"
    done
  else
    for tox_candidate in "$(dirname "$tox_library")"/libtoxcore*.dylib; do
      cp -L "$tox_candidate" "$tox_prefix/lib/$(basename "$tox_candidate")"
    done
  fi
  promote_prepared_group c-toxcore "$tox_prefix"
fi

if [[ "$platform" == "linux" ]]; then
  tor_name="tor-expert-bundle-linux-x86_64-15.0.25.tar.gz"
  tor_sha="19cf18726eecb362e0f21d27afa9ea9efe5da928bfdfbb1ceb5fe54519e87f4a"
  tor_size='32448097'
  tor_archive="$download_dir/$tor_name"
  download_verified "$tor_base/$tor_name" "$tor_archive" "$tor_size" "$tor_sha"
  lyrebird_linux_name="lyrebird-0.9.0-kaigen-snowflake2.15.1-pion4.2.23-dtls3.1.12-linux-amd64-go1.27.2.tar.gz"
  lyrebird_linux_archive="$download_dir/$lyrebird_linux_name"
  lyrebird_linux_sha="077b6b40bc7606b41d29476f874df144733b977ef20f4916048bf8c8f9503685"
  lyrebird_linux_size="13808459"
  lyrebird_linux_binary_sha="71f6a40359abf57aa18d0141124edac97c2ea3508b9475a0885ba2a60e9a5876"
  lyrebird_linux_binary_size="27123756"
  seed_verified_vendor_input "$lyrebird_linux_name" "$lyrebird_linux_size" "$lyrebird_linux_sha"
  lyrebird_linux_cache="$(component_cache_path "$lyrebird_linux_name" "$lyrebird_linux_sha")"
  assert_file_identity "$lyrebird_linux_cache" "$lyrebird_linux_size" "$lyrebird_linux_sha" "Canonical locally compiled Linux Lyrebird"
  if [[ -L "$lyrebird_linux_archive" || ( -e "$lyrebird_linux_archive" && ! -f "$lyrebird_linux_archive" ) ]]; then
    echo "Linux Lyrebird materialization path is unsafe: $lyrebird_linux_archive" >&2
    exit 1
  fi
  cp -p -- "$lyrebird_linux_cache" "$lyrebird_linux_archive"
  assert_file_identity "$lyrebird_linux_archive" "$lyrebird_linux_size" "$lyrebird_linux_sha" "Materialized Linux Lyrebird"
  conjure_linux_name="conjure-0090962226b82aa4a8fc38506f9b98de67d0781e-kaigen-utls1.8.2-snowflake2.15.1-linux-amd64-go1.27.2.tar.gz"
  conjure_linux_archive="$download_dir/$conjure_linux_name"
  conjure_linux_sha="78e2393a368469ce6c3cf7c5baed5965ae652a11fd59d3a99a87845fd0c28f73"
  conjure_linux_size="11122536"
  conjure_linux_binary_sha="1ae2b23c26b1986501de50df2070a5acef4a0f68d081f16660d4e7c3b24b8f41"
  conjure_linux_binary_size="21188589"
  seed_verified_vendor_input "$conjure_linux_name" "$conjure_linux_size" "$conjure_linux_sha"
  download_verified "" "$conjure_linux_archive" "$conjure_linux_size" "$conjure_linux_sha"
  if ! restore_prepared_group tor-universal "$platform_dir/TorExpertBundle"; then
    rm -rf "$platform_dir/TorExpertBundle"
    mkdir -p "$platform_dir/TorExpertBundle"
    tar -xzf "$tor_archive" -C "$platform_dir/TorExpertBundle"
    tar -xzf "$lyrebird_linux_archive" -C "$platform_dir/TorExpertBundle/tor/pluggable_transports" lyrebird LICENSE LICENSE-GPL3.txt
    assert_file_identity "$platform_dir/TorExpertBundle/tor/pluggable_transports/lyrebird" "$lyrebird_linux_binary_size" "$lyrebird_linux_binary_sha" "Pinned Linux Lyrebird overlay"
    tar -xzf "$conjure_linux_archive" -C "$platform_dir/TorExpertBundle/tor/pluggable_transports" conjure-client CONJURE-LICENSE
    assert_file_identity "$platform_dir/TorExpertBundle/tor/pluggable_transports/conjure-client" "$conjure_linux_binary_size" "$conjure_linux_binary_sha" "Pinned Linux Conjure overlay"
    # The official archive also contains detached ELF debug symbols. They are
    # not runtime files and linuxdeploy otherwise tries to patch them as shared
    # libraries, which corrupts AppImage dependency discovery.
    rm -rf "$platform_dir/TorExpertBundle/debug"
    chmod +x "$platform_dir/TorExpertBundle/tor/tor" \
      "$platform_dir/TorExpertBundle/tor/pluggable_transports/lyrebird" \
      "$platform_dir/TorExpertBundle/tor/pluggable_transports/conjure-client"
    apply_geoip_overlay "$platform_dir/TorExpertBundle"
    promote_prepared_group tor-universal "$platform_dir/TorExpertBundle"
  fi
else
  tor_x64_name="tor-expert-bundle-macos-x86_64-15.0.25.tar.gz"
  tor_arm_name="tor-expert-bundle-macos-aarch64-15.0.25.tar.gz"
  tor_x64_archive="$download_dir/$tor_x64_name"
  tor_arm_archive="$download_dir/$tor_arm_name"
  download_verified "$tor_base/$tor_x64_name" "$tor_x64_archive" \
    "19422031" "e1ae4d4a734d28bb590839188511deb3cebc26fcbce9df66d01b2c452060fe95"
  download_verified "$tor_base/$tor_arm_name" "$tor_arm_archive" \
    "18793521" "a3febb6179152b0b4f56a0f5cc57bf5cc8ecef7db35e7c3e9d5a044c8158c26c"
  lyrebird_macos_name="lyrebird-0.9.0-kaigen-snowflake2.15.1-pion4.2.23-dtls3.1.12-macos-universal-go1.26.8.tar.gz"
  lyrebird_macos_archive="$download_dir/$lyrebird_macos_name"
  lyrebird_macos_sha="e692b6af603f409b9c8306adc5acb763f9fd3cef76bd76d5541d37004aed69b3"
  lyrebird_macos_size="26234544"
  lyrebird_macos_binary_sha="3cb91c10829e0875ed2ef13b6062d1b9746c9ae884b7b54de6cc65b5cac25b80"
  lyrebird_macos_binary_size="52032226"
  seed_verified_vendor_input "$lyrebird_macos_name" "$lyrebird_macos_size" "$lyrebird_macos_sha"
  lyrebird_macos_cache="$(component_cache_path "$lyrebird_macos_name" "$lyrebird_macos_sha")"
  assert_file_identity "$lyrebird_macos_cache" "$lyrebird_macos_size" "$lyrebird_macos_sha" "Canonical locally compiled macOS Lyrebird"
  if [[ -L "$lyrebird_macos_archive" || ( -e "$lyrebird_macos_archive" && ! -f "$lyrebird_macos_archive" ) ]]; then
    echo "macOS Lyrebird materialization path is unsafe: $lyrebird_macos_archive" >&2
    exit 1
  fi
  cp -p -- "$lyrebird_macos_cache" "$lyrebird_macos_archive"
  assert_file_identity "$lyrebird_macos_archive" "$lyrebird_macos_size" "$lyrebird_macos_sha" "Materialized macOS Lyrebird"
  tor_universal_dir="$platform_dir/TorExpertBundle"
  conjure_macos_name="conjure-0090962226b82aa4a8fc38506f9b98de67d0781e-kaigen-utls1.8.2-snowflake2.15.1-macos-universal-go1.26.8.tar.gz"
  conjure_macos_archive="$download_dir/$conjure_macos_name"
  conjure_macos_sha="38dec9832204b1d931452bc0241ac893488b9460cf2400e4f624f6ed8f19b9e4"
  conjure_macos_size="21199873"
  conjure_macos_binary_sha="62aa3040a74ac3221351122d755aadcdb28ab8baa97c3d5560cf474b45cfa572"
  conjure_macos_binary_size="41165842"
  seed_verified_vendor_input "$conjure_macos_name" "$conjure_macos_size" "$conjure_macos_sha"
  download_verified "" "$conjure_macos_archive" "$conjure_macos_size" "$conjure_macos_sha"
  if ! restore_prepared_group tor-universal "$tor_universal_dir"; then
    tor_x64_dir="$platform_dir/TorExpertBundle-x86_64"
    tor_arm_dir="$platform_dir/TorExpertBundle-arm64"
    rm -rf "$tor_x64_dir" "$tor_arm_dir" "$tor_universal_dir"
    mkdir -p "$tor_x64_dir" "$tor_arm_dir"
    tar -xzf "$tor_x64_archive" -C "$tor_x64_dir"
    tar -xzf "$tor_arm_archive" -C "$tor_arm_dir"
    cp -R "$tor_arm_dir" "$tor_universal_dir"
    for relative in \
      tor/tor \
      tor/libevent-2.1.7.dylib; do
      merged="$tor_universal_dir/$relative.universal"
      lipo -create "$tor_x64_dir/$relative" "$tor_arm_dir/$relative" \
        -output "$merged"
      mv "$merged" "$tor_universal_dir/$relative"
      chmod +x "$tor_universal_dir/$relative"
    done
    tar -xzf "$lyrebird_macos_archive" -C "$tor_universal_dir/tor/pluggable_transports" lyrebird LICENSE LICENSE-GPL3.txt
    assert_file_identity "$tor_universal_dir/tor/pluggable_transports/lyrebird" "$lyrebird_macos_binary_size" "$lyrebird_macos_binary_sha" "Pinned macOS Lyrebird overlay"
    tar -xzf "$conjure_macos_archive" -C "$tor_universal_dir/tor/pluggable_transports" conjure-client CONJURE-LICENSE
    assert_file_identity "$tor_universal_dir/tor/pluggable_transports/conjure-client" "$conjure_macos_binary_size" "$conjure_macos_binary_sha" "Pinned macOS Conjure overlay"
    chmod +x "$tor_universal_dir/tor/pluggable_transports/lyrebird" "$tor_universal_dir/tor/pluggable_transports/conjure-client"
    rm -rf "$tor_x64_dir" "$tor_arm_dir"
    apply_geoip_overlay "$tor_universal_dir"
    promote_prepared_group tor-universal "$tor_universal_dir"
  fi
fi

echo "Prepared $platform native dependencies in $platform_dir"
