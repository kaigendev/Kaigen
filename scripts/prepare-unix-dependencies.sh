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
for command in curl unzip tar cmake ninja make; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is missing: $command" >&2
    exit 1
  fi
done
if [[ "$platform" == "macos" ]] && ! command -v lipo >/dev/null 2>&1; then
  echo "Required Xcode command is missing: lipo" >&2
  exit 1
fi

project_root="$(cd "$(dirname "$0")/.." && pwd)"
work_root="$project_root/work"
download_dir="$work_root/downloads"
source_dir="$work_root/platform-sources"
platform_dir="$work_root/platform/$platform"
jobs="${KAIGEN_BUILD_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)}"

toxcore_commit="1d79022fb4e56dffe0bbd075d47e00f7a0b62ab3"
toxcore_url="https://codeload.github.com/TokTok/c-toxcore/zip/$toxcore_commit"
toxcore_sha="8764ec0e15448f2f76e1e0dcac15bbdac959d8519bd3e274d1126c302fb56506"
cmp_commit="52bfcfa17d2eb4322da2037ad625f5575129cece"
cmp_url="https://codeload.github.com/TokTok/cmp/zip/$cmp_commit"
cmp_sha="281bb25882e4186187df555775dd3cd57943ecfafc70b5d5076bec9dee02672d"
sodium_url="https://codeload.github.com/jedisct1/libsodium/tar.gz/refs/tags/1.0.22"
sodium_sha="729efdb75be22abed3ef31824674976af43008f900bad9b576ce412d6f659175"
tor_base="https://archive.torproject.org/tor-package-archive/torbrowser/15.0.19"

mkdir -p "$download_dir" "$source_dir" "$platform_dir"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print tolower($1)}'
  else
    shasum -a 256 "$1" | awk '{print tolower($1)}'
  fi
}

download_verified() {
  local url="$1" destination="$2" expected="$3"
  if [[ -f "$destination" ]] && [[ "$(sha256_file "$destination")" == "$expected" ]]; then
    return
  fi
  rm -f "$destination"
  curl --fail --location --retry 4 --retry-delay 2 --output "$destination" "$url"
  local actual
  actual="$(sha256_file "$destination")"
  if [[ "$actual" != "$expected" ]]; then
    echo "SHA-256 mismatch for $destination: expected $expected, got $actual" >&2
    exit 1
  fi
}

tox_archive="$download_dir/c-toxcore-$toxcore_commit.zip"
cmp_archive="$download_dir/cmp-$cmp_commit.zip"
sodium_archive="$download_dir/libsodium-1.0.22.tar.gz"
download_verified "$toxcore_url" "$tox_archive" "$toxcore_sha"
download_verified "$cmp_url" "$cmp_archive" "$cmp_sha"
download_verified "$sodium_url" "$sodium_archive" "$sodium_sha"

tox_source="$source_dir/c-toxcore-$toxcore_commit"
if [[ ! -f "$tox_source/CMakeLists.txt" ]]; then
  rm -rf "$tox_source" "$source_dir/tox-extract"
  mkdir -p "$source_dir/tox-extract"
  unzip -q "$tox_archive" -d "$source_dir/tox-extract"
  mv "$source_dir/tox-extract"/* "$tox_source"
  rmdir "$source_dir/tox-extract"
fi

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
  tor_name="tor-expert-bundle-linux-x86_64-15.0.19.tar.gz"
  tor_sha="5a8f19f5f119b5fa2a8fd799a3a532e3236ad36164241800d6302e32f0e1c2a9"
  tor_archive="$download_dir/$tor_name"
  download_verified "$tor_base/$tor_name" "$tor_archive" "$tor_sha"
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
  tor_x64_name="tor-expert-bundle-macos-x86_64-15.0.19.tar.gz"
  tor_arm_name="tor-expert-bundle-macos-aarch64-15.0.19.tar.gz"
  tor_x64_archive="$download_dir/$tor_x64_name"
  tor_arm_archive="$download_dir/$tor_arm_name"
  download_verified "$tor_base/$tor_x64_name" "$tor_x64_archive" \
    "95243f76bcf05d6179d017c3f3e4ece7b53cc58dff1ba617b03a2fe2c8298b5b"
  download_verified "$tor_base/$tor_arm_name" "$tor_arm_archive" \
    "c99cf6f69740a443c7fffaf598ceb0952b3914041507c8afe11bed84a3333eb1"
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
