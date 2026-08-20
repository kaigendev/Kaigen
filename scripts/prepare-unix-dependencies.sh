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

for command in awk cp dirname mkdir mv rm stat tr unzip tar cmake ninja make; do
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

toxcore_commit="1d79022fb4e56dffe0bbd075d47e00f7a0b62ab3"
toxcore_url="https://codeload.github.com/TokTok/c-toxcore/zip/$toxcore_commit"
toxcore_sha="8764ec0e15448f2f76e1e0dcac15bbdac959d8519bd3e274d1126c302fb56506"
toxcore_size='1354914'
cmp_commit="52bfcfa17d2eb4322da2037ad625f5575129cece"
cmp_url="https://codeload.github.com/TokTok/cmp/zip/$cmp_commit"
cmp_sha="281bb25882e4186187df555775dd3cd57943ecfafc70b5d5076bec9dee02672d"
cmp_size='52550'
sodium_url="https://codeload.github.com/jedisct1/libsodium/tar.gz/refs/tags/1.0.22"
sodium_sha="729efdb75be22abed3ef31824674976af43008f900bad9b576ce412d6f659175"
sodium_size='2268897'
tor_base="https://archive.torproject.org/tor-package-archive/torbrowser/15.0.20"

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

apply_kaigen_toxcore_retry_cap() {
  local source="$1" header="$1/toxcore/Messenger.h" implementation="$1/toxcore/Messenger.c"
  local temporary
  if ! grep -q '^#define FRIENDREQUEST_TIMEOUT_MAX 60$' "$header"; then
    if ! grep -q '^#define FRIENDREQUEST_TIMEOUT 5$' "$header"; then
      echo "The pinned c-toxcore friend-request timeout declaration changed; review the Kaigen retry-cap patch." >&2
      exit 1
    fi
    temporary="$(mktemp)"
    awk '{ print; if ($0 == "#define FRIENDREQUEST_TIMEOUT 5") { print "/** Kaigen keeps offline authorisation retries responsive. */"; print "#define FRIENDREQUEST_TIMEOUT_MAX 60" } }' "$header" > "$temporary"
    mv "$temporary" "$header"
  fi
  if ! grep -q 'min_u32(f->friendrequest_timeout \* 2, FRIENDREQUEST_TIMEOUT_MAX);' "$implementation"; then
    if ! grep -q 'f->friendrequest_timeout \*= 2;' "$implementation"; then
      echo "The pinned c-toxcore friend-request retry implementation changed; review the Kaigen retry-cap patch." >&2
      exit 1
    fi
    temporary="$(mktemp)"
    awk '{ if ($0 == "        f->friendrequest_timeout *= 2;") { print "        f->friendrequest_timeout ="; print "            min_u32(f->friendrequest_timeout * 2, FRIENDREQUEST_TIMEOUT_MAX);" } else { print } }' "$implementation" > "$temporary"
    mv "$temporary" "$implementation"
  fi
}

tox_archive="$download_dir/c-toxcore-$toxcore_commit.zip"
cmp_archive="$download_dir/cmp-$cmp_commit.zip"
sodium_archive="$download_dir/libsodium-1.0.22.tar.gz"
download_verified "$toxcore_url" "$tox_archive" "$toxcore_size" "$toxcore_sha"
download_verified "$cmp_url" "$cmp_archive" "$cmp_size" "$cmp_sha"
download_verified "$sodium_url" "$sodium_archive" "$sodium_size" "$sodium_sha"

tox_source="$source_dir/c-toxcore-$toxcore_commit"
if [[ ! -f "$tox_source/CMakeLists.txt" ]]; then
  rm -rf "$tox_source" "$source_dir/tox-extract"
  mkdir -p "$source_dir/tox-extract"
  unzip -q "$tox_archive" -d "$source_dir/tox-extract"
  mv "$source_dir/tox-extract"/* "$tox_source"
  rmdir "$source_dir/tox-extract"
fi
apply_kaigen_toxcore_retry_cap "$tox_source"

if [[ ! -f "$tox_source/third_party/cmp/cmp.c" ]]; then
  rm -rf "$tox_source/third_party/cmp" "$source_dir/cmp-extract"
  mkdir -p "$source_dir/cmp-extract"
  unzip -q "$cmp_archive" -d "$source_dir/cmp-extract"
  mv "$source_dir/cmp-extract"/* "$tox_source/third_party/cmp"
  rmdir "$source_dir/cmp-extract"
fi

sodium_source="$source_dir/libsodium-1.0.22"
if [[ ! -x "$sodium_source/configure" ]]; then
  rm -rf "$sodium_source"
  tar -xzf "$sodium_archive" -C "$source_dir"
fi

sodium_prefix="$platform_dir/libsodium"
sodium_build="$platform_dir/libsodium-build"
rm -rf "$sodium_prefix" "$sodium_build"
cp -R "$sodium_source" "$sodium_build"
pushd "$sodium_build" >/dev/null
if [[ "$platform" == "macos" ]]; then
  export CFLAGS="-O2 -fPIC -arch x86_64 -arch arm64 -mmacosx-version-min=11.0"
  export LDFLAGS="-arch x86_64 -arch arm64 -mmacosx-version-min=11.0"
else
  # libsodium is linked into the portable shared libtoxcore.so.
  export CFLAGS="-O2 -fPIC"
fi
./configure --prefix="$sodium_prefix" --disable-shared --enable-static --with-pic
make -j"$jobs"
make install
popd >/dev/null

tox_build="$platform_dir/toxcore-build"
tox_prefix="$platform_dir/toxcore"
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
    -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0
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

if [[ "$platform" == "linux" ]]; then
  tor_name="tor-expert-bundle-linux-x86_64-15.0.20.tar.gz"
  tor_sha="3b39a2a7fbf43ef28b9ae0a6afca02a12935232f81769e4fef7472d6b5676eaf"
  tor_size='32211167'
  tor_archive="$download_dir/$tor_name"
  download_verified "$tor_base/$tor_name" "$tor_archive" "$tor_size" "$tor_sha"
  rm -rf "$platform_dir/TorExpertBundle"
  mkdir -p "$platform_dir/TorExpertBundle"
  tar -xzf "$tor_archive" -C "$platform_dir/TorExpertBundle"
  # The official archive also contains detached ELF debug symbols. They are
  # not runtime files and linuxdeploy otherwise tries to patch them as shared
  # libraries, which corrupts AppImage dependency discovery.
  rm -rf "$platform_dir/TorExpertBundle/debug"
  chmod +x "$platform_dir/TorExpertBundle/tor/tor" \
    "$platform_dir/TorExpertBundle/tor/pluggable_transports/lyrebird" \
    "$platform_dir/TorExpertBundle/tor/pluggable_transports/conjure-client"
else
  tor_x64_name="tor-expert-bundle-macos-x86_64-15.0.20.tar.gz"
  tor_arm_name="tor-expert-bundle-macos-aarch64-15.0.20.tar.gz"
  tor_x64_archive="$download_dir/$tor_x64_name"
  tor_arm_archive="$download_dir/$tor_arm_name"
  download_verified "$tor_base/$tor_x64_name" "$tor_x64_archive" \
    "19251761" "6ec3048b3a5d55e297f35d84830d0e338884d702aac3db49056633c1223841df"
  download_verified "$tor_base/$tor_arm_name" "$tor_arm_archive" \
    "18617670" "73fdccde8136678e41a625160993e6a9dc4f4ff8cd376318b5e41e5627d55682"
  tor_x64_dir="$platform_dir/TorExpertBundle-x86_64"
  tor_arm_dir="$platform_dir/TorExpertBundle-arm64"
  tor_universal_dir="$platform_dir/TorExpertBundle"
  rm -rf "$tor_x64_dir" "$tor_arm_dir" "$tor_universal_dir"
  mkdir -p "$tor_x64_dir" "$tor_arm_dir"
  tar -xzf "$tor_x64_archive" -C "$tor_x64_dir"
  tar -xzf "$tor_arm_archive" -C "$tor_arm_dir"
  cp -R "$tor_arm_dir" "$tor_universal_dir"
  for relative in \
    tor/tor \
    tor/libevent-2.1.7.dylib \
    tor/pluggable_transports/lyrebird \
    tor/pluggable_transports/conjure-client; do
    merged="$tor_universal_dir/$relative.universal"
    lipo -create "$tor_x64_dir/$relative" "$tor_arm_dir/$relative" \
      -output "$merged"
    mv "$merged" "$tor_universal_dir/$relative"
    chmod +x "$tor_universal_dir/$relative"
  done
  rm -rf "$tor_x64_dir" "$tor_arm_dir"
fi

echo "Prepared $platform native dependencies in $platform_dir"
