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

toxcore_commit="1d79022fb4e56dffe0bbd075d47e00f7a0b62ab3"
toxcore_url="https://codeload.github.com/TokTok/c-toxcore/zip/$toxcore_commit"
toxcore_sha="8764ec0e15448f2f76e1e0dcac15bbdac959d8519bd3e274d1126c302fb56506"
toxcore_size='1354914'
security_v4_directory="$project_root/patches/c-toxcore/security-v4"
security_v4_manifest="$security_v4_directory/patch-manifest.json"
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

git_tree() {
  local entry metadata path mode object stage
  git -C "$1" add --all
  while IFS= read -r -d '' entry; do
    metadata="${entry%%$'\t'*}"
    path="${entry#*$'\t'}"
    read -r mode object stage <<< "$metadata"
    case "$mode" in
      100755|120000)
        git -C "$1" update-index --cacheinfo "100644,$object,$path"
        ;;
    esac
  done < <(git -C "$1" ls-files --stage -z)
  git -C "$1" write-tree
}

apply_kaigen_toxcore_security_v4() {
  local source="$1" initial_tree final_tree baseline_tree candidate_tree
  local index patch_file patch_bytes patch_sha before_tree after_tree patch_path actual_tree
  local -a metadata
  if [[ ! -f "$security_v4_manifest" || -L "$security_v4_manifest" ]]; then
    echo "c-toxcore security-v4 patch manifest is missing or unsafe: $security_v4_manifest" >&2
    exit 1
  fi
  assert_file_identity "$project_root/patches/c-toxcore/friend-request-retry-cap.patch" '541' \
    'b01178630cc6869b21e314dddc2191dce59a31d5439b48ff2ca9162128532ccb' "Kaigen retry-cap baseline patch"
  metadata=()
  while IFS= read -r line; do
    metadata+=("$line")
  done < <(node - "$security_v4_manifest" "$toxcore_commit" "$toxcore_size" "$toxcore_sha" <<'NODE'
const fs = require('fs');
const [manifestPath, commit, bytes, sha] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const fail = message => { throw new Error(message); };
const base = manifest.applicationBase?.upstream;
const cmp = manifest.applicationBase?.cmp;
const prior = manifest.applicationBase?.priorKaigenPatch;
if (manifest.schemaVersion !== 1 || manifest.series !== 'security-v4' ||
    base?.commit !== commit || base.archive?.file !== `c-toxcore-${commit}.zip` ||
    String(base.archive?.bytes) !== bytes || base.archive?.sha256?.toLowerCase() !== sha.toLowerCase() ||
    cmp?.commit !== '52bfcfa17d2eb4322da2037ad625f5575129cece' || cmp.archive?.file !== 'cmp-52bfcfa17d2eb4322da2037ad625f5575129cece.zip' ||
    cmp.archive?.bytes !== 52550 || cmp.archive?.sha256 !== '281BB25882E4186187DF555775DD3CD57943ECFAFC70B5D5076BEC9DEE02672D' ||
    prior?.file !== '../friend-request-retry-cap.patch' || prior.bytes !== 541 || prior.sha256 !== 'B01178630CC6869B21E314DDDC2191DCE59A31D5439B48FF2CA9162128532CCB' ||
    !Array.isArray(manifest.requiredOrder) || manifest.requiredOrder.length !== 8 ||
    !Array.isArray(manifest.patches) || manifest.patches.length !== 8 ||
    !/^[0-9a-f]{40}$/.test(manifest.applicationBase?.materializedBaseline?.tree ?? '') ||
    !/^[0-9a-f]{40}$/.test(manifest.candidate?.headTree ?? '')) fail('invalid manifest base');
for (let index = 0; index < manifest.patches.length; index += 1) {
  const patch = manifest.patches[index];
  if (patch.order !== index + 1 || patch.file !== manifest.requiredOrder[index] ||
      patch.file.includes('/') || patch.file.includes('\\') ||
      !Number.isSafeInteger(patch.bytes) || patch.bytes <= 0 || !/^[0-9A-F]{64}$/.test(patch.sha256 ?? '') ||
      !/^[0-9a-f]{40}$/.test(patch.beforeTree ?? '') || !/^[0-9a-f]{40}$/.test(patch.afterTree ?? '') ||
      (index > 0 && patch.beforeTree !== manifest.patches[index - 1].afterTree)) fail('invalid manifest patch chain');
}
if (manifest.patches[0].beforeTree !== manifest.applicationBase.materializedBaseline.tree ||
    manifest.patches.at(-1).afterTree !== manifest.candidate.headTree) fail('invalid manifest tree endpoints');
console.log(manifest.applicationBase.materializedBaseline.tree);
console.log(manifest.candidate.headTree);
for (const patch of manifest.patches) console.log([patch.file, patch.bytes, patch.sha256.toLowerCase(), patch.beforeTree, patch.afterTree].join('|'));
NODE
)
  if [[ ${#metadata[@]} -ne 10 ]]; then
    echo "c-toxcore security-v4 manifest validation failed" >&2
    exit 1
  fi
  baseline_tree="${metadata[0]}"
  candidate_tree="${metadata[1]}"
  for ((index = 0; index < 8; index += 1)); do
    IFS='|' read -r patch_file patch_bytes patch_sha before_tree after_tree <<< "${metadata[$((index + 2))]}"
    assert_file_identity "$security_v4_directory/$patch_file" "$patch_bytes" "$patch_sha" "c-toxcore security-v4 patch"
  done

  git -C "$source" init -q
  initial_tree="$(git_tree "$source")"
  if [[ "$initial_tree" != "$baseline_tree" && "$initial_tree" != "$candidate_tree" ]]; then
    echo "Materialized c-toxcore is partial or mismatched before security-v4 application: $initial_tree" >&2
    exit 1
  fi
  if [[ "$initial_tree" != "$candidate_tree" ]]; then
    for ((index = 0; index < 8; index += 1)); do
      IFS='|' read -r patch_file patch_bytes patch_sha before_tree after_tree <<< "${metadata[$((index + 2))]}"
      patch_path="$security_v4_directory/$patch_file"
      if git -C "$source" apply --reverse --check "$patch_path" >/dev/null 2>&1; then
        echo "Materialized c-toxcore unexpectedly contains a partial security-v4 patch: $patch_file" >&2
        exit 1
      fi
      if ! git -C "$source" apply --check "$patch_path"; then
        echo "c-toxcore security-v4 patch does not apply cleanly: $patch_file" >&2
        exit 1
      fi
      git -C "$source" apply "$patch_path"
      actual_tree="$(git_tree "$source")"
      if [[ "$actual_tree" != "$after_tree" ]]; then
        echo "c-toxcore security-v4 tree mismatch after $patch_file: $actual_tree" >&2
        exit 1
      fi
    done
  fi
  final_tree="$(git_tree "$source")"
  if [[ "$final_tree" != "$candidate_tree" ]]; then
    echo "c-toxcore security-v4 final tree mismatch: $final_tree" >&2
    exit 1
  fi
}

tox_archive="$download_dir/c-toxcore-$toxcore_commit.zip"
cmp_archive="$download_dir/cmp-$cmp_commit.zip"
sodium_archive="$download_dir/libsodium-1.0.22.tar.gz"
download_verified "$toxcore_url" "$tox_archive" "$toxcore_size" "$toxcore_sha"
download_verified "$cmp_url" "$cmp_archive" "$cmp_size" "$cmp_sha"
download_verified "$sodium_url" "$sodium_archive" "$sodium_size" "$sodium_sha"

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
  sodium_source="$source_dir/libsodium-1.0.22"
  if [[ ! -x "$sodium_source/configure" ]]; then
    rm -rf "$sodium_source"
    tar -xzf "$sodium_archive" -C "$source_dir"
  fi
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
  promote_prepared_group libsodium "$sodium_prefix"
fi

tox_build="$platform_dir/toxcore-build"
tox_prefix="$platform_dir/toxcore"
if restore_prepared_group c-toxcore "$tox_prefix"; then
  rm -rf "$tox_build"
else
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
  apply_kaigen_toxcore_retry_cap "$tox_source"
  apply_kaigen_toxcore_security_v4 "$tox_source"

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
  promote_prepared_group c-toxcore "$tox_prefix"
fi

if [[ "$platform" == "linux" ]]; then
  tor_name="tor-expert-bundle-linux-x86_64-15.0.20.tar.gz"
  tor_sha="3b39a2a7fbf43ef28b9ae0a6afca02a12935232f81769e4fef7472d6b5676eaf"
  tor_size='32211167'
  tor_archive="$download_dir/$tor_name"
  download_verified "$tor_base/$tor_name" "$tor_archive" "$tor_size" "$tor_sha"
  if ! restore_prepared_group tor-universal "$platform_dir/TorExpertBundle"; then
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
    promote_prepared_group tor-universal "$platform_dir/TorExpertBundle"
  fi
else
  tor_x64_name="tor-expert-bundle-macos-x86_64-15.0.20.tar.gz"
  tor_arm_name="tor-expert-bundle-macos-aarch64-15.0.20.tar.gz"
  tor_x64_archive="$download_dir/$tor_x64_name"
  tor_arm_archive="$download_dir/$tor_arm_name"
  download_verified "$tor_base/$tor_x64_name" "$tor_x64_archive" \
    "19251761" "6ec3048b3a5d55e297f35d84830d0e338884d702aac3db49056633c1223841df"
  download_verified "$tor_base/$tor_arm_name" "$tor_arm_archive" \
    "18617670" "73fdccde8136678e41a625160993e6a9dc4f4ff8cd376318b5e41e5627d55682"
  tor_universal_dir="$platform_dir/TorExpertBundle"
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
    promote_prepared_group tor-universal "$tor_universal_dir"
  fi
fi

echo "Prepared $platform native dependencies in $platform_dir"
