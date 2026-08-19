import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

const [
  tauriConfigText,
  rustApp,
  instance,
  tor,
  appImageBuild,
  appRunTemplate,
  appRunTest,
  appImageCacheTest,
  macBuild,
  windowsBuild,
  linuxGuide,
  platformGuide,
  macGuide,
  unixWorkflow,
  packageJsonText,
  packageLockText,
  cargoManifest,
  cargoLock,
] = await Promise.all([
  read("src-tauri/tauri.conf.json"),
  read("src-tauri/src/lib.rs"),
  read("src-tauri/src/instance.rs"),
  read("src-tauri/src/tor.rs"),
  read("scripts/build-appimage.sh"),
  read("packaging/AppRun-linux.sh"),
  read("scripts/test-apprun-linux.sh"),
  read("scripts/test-appimage-tool-cache.sh"),
  read("scripts/build-macos.sh"),
  read("scripts/build-portable.ps1"),
  read("packaging/PORTABLE-LINUX.txt"),
  read("BUILDING-PLATFORMS.md"),
  read("packaging/PORTABLE-MACOS.txt"),
  read(".github/workflows/build-unix.yml"),
  read("package.json"),
  read("package-lock.json"),
  read("src-tauri/Cargo.toml"),
  read("src-tauri/Cargo.lock"),
]);

const tauriConfig = JSON.parse(tauriConfigText);
const packageJson = JSON.parse(packageJsonText);
const packageLock = JSON.parse(packageLockText);
const unixBuildScripts = [appImageBuild, macBuild];

function unixGuardedByteManifest(fileBytes, inProjectArtifacts = "artifacts") {
  const generatedPrefixes = [".git", "node_modules", "dist", "src-tauri/target", "src-tauri/gen/schemas", "work"];
  return new Map(
    [...fileBytes]
      .filter(([sourcePath]) => sourcePath !== ".kaigen-lab-source")
      .filter(([sourcePath]) => !generatedPrefixes.some((prefix) => sourcePath === prefix || sourcePath.startsWith(`${prefix}/`)))
      .filter(([sourcePath]) => sourcePath !== inProjectArtifacts && !sourcePath.startsWith(`${inProjectArtifacts}/`)),
  );
}

function changedManifestPaths(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((sourcePath) => before.get(sourcePath) !== after.get(sourcePath))
    .sort();
}
assert.equal(tauriConfig.productName, "Kaigen");
assert.equal(tauriConfig.mainBinaryName, "Kaigen");
assert.equal(tauriConfig.identifier, "io.github.kaigendev.kaigen");
assert.equal(packageJson.name, "kaigen");
assert.equal(packageLock.name, "kaigen");
assert.equal(packageLock.packages?.[""]?.name, "kaigen");
assert.match(cargoManifest, /^name = "kaigen"$/m);
assert.match(cargoLock, /\[\[package\]\]\r?\nname = "kaigen"\r?\nversion = "0\.2\.1"/);
assert.ok(cargoLock.indexOf('name = "kaigen"') < cargoLock.indexOf('name = "keyboard-types"'));
assert.doesNotMatch(`${packageJsonText}\n${packageLockText}\n${cargoManifest}\n${cargoLock}`, /tox-pq-client/i);

const webkitSetup = rustApp.indexOf("WEBKIT_DISABLE_DMABUF_RENDERER");
const tauriBuilder = rustApp.indexOf("tauri::Builder::default()");
assert.ok(webkitSetup >= 0 && webkitSetup < tauriBuilder);
assert.match(rustApp, /var_os\("WEBKIT_DISABLE_DMABUF_RENDERER"\)/);
assert.match(rustApp, /should_default_linux_dmabuf_renderer/);

const appRunArgSnapshot = appRunTemplate.indexOf('kaigen_apprun_argv=("$@")');
const appRunSessionSnapshot = appRunTemplate.indexOf('kaigen_session_type="${XDG_SESSION_TYPE-}"');
const appRunGdkSnapshot = appRunTemplate.indexOf('if [[ ${GDK_BACKEND+x} == x ]]');
const appRunWebKitSnapshot = appRunTemplate.indexOf('if [[ ${WEBKIT_DISABLE_DMABUF_RENDERER+x} == x ]]');
const appRunHook = appRunTemplate.indexOf('source "$this_dir"/apprun-hooks/"linuxdeploy-plugin-gtk.sh"');
const appRunGdkRestore = appRunTemplate.indexOf('export GDK_BACKEND="$gdk_backend_value"');
const appRunWebKitRestore = appRunTemplate.indexOf('export WEBKIT_DISABLE_DMABUF_RENDERER="$webkit_dmabuf_value"');
const appRunExec = appRunTemplate.indexOf('exec "$this_dir"/AppRun.wrapped "${kaigen_apprun_argv[@]}"');
assert.ok(
  appRunArgSnapshot >= 0 &&
    appRunSessionSnapshot > appRunArgSnapshot &&
    appRunGdkSnapshot > appRunSessionSnapshot &&
    appRunWebKitSnapshot > appRunGdkSnapshot &&
    appRunHook > appRunWebKitSnapshot &&
    appRunGdkRestore > appRunHook &&
    appRunWebKitRestore > appRunGdkRestore &&
    appRunExec > appRunWebKitRestore,
  "AppRun must snapshot caller argv/session/overrides before the generated hook and restore policy before exec",
);
assert.match(appRunTemplate, /^# KAIGEN_APPRUN_BACKEND_POLICY_V1$/m);
assert.match(appRunTemplate, /kaigen_wayland_display="\$\{WAYLAND_DISPLAY-\}"/);
assert.match(appRunTemplate, /\$kaigen_session_type == wayland && -n \$kaigen_wayland_display/);
assert.doesNotMatch(appRunTemplate, /\$\{(?:GDK_BACKEND|WEBKIT_DISABLE_DMABUF_RENDERER):-/);
for (const matrixCase of [
  "wayland-default",
  "x11-default",
  "incomplete-wayland",
  "absent-session",
  "contradictory-session",
  "absent-wayland-display",
  "explicit-x11",
  "explicit-wayland",
  "explicit-empty-gdk",
  "explicit-gdk-zero",
  "explicit-webkit-zero",
  "explicit-empty-webkit",
]) {
  assert.match(appRunTest, new RegExp(`run_case ${matrixCase.replaceAll("-", "\\-")}\\b`));
}
assert.match(appRunTest, /set -- hook-mutated/);
assert.match(appRunTest, /ARG_2=--leading-dash/);
assert.match(appRunTest, /KAIGEN_APPRUN_TEST_EXIT=37/);
assert.match(appRunTest, /kill -TERM "\$signal_pid"/);
assert.match(appRunTest, /signal_status -ne 143/);

assert.match(rustApp, /fn tray_base_image\(\)/);
assert.match(rustApp, /set_icon_with_as_template/);
assert.match(rustApp, /icon_as_template\(cfg!\(target_os = "macos"\)\)/);
assert.doesNotMatch(instance, /osascript|System Events|display alert/);
assert.doesNotMatch(instance, /\.status\(\)/);
assert.match(
  instance,
  /Command::new\("\/usr\/bin\/open"\)\s*\.arg\("-t"\)\s*\.arg\(&path\)[^]*?\.spawn\(\)/,
);
assert.match(
  instance,
  /Command::new\("\/usr\/bin\/open"\)\s*\.arg\("-n"\)\s*\.arg\(&layout\.destination_app\)[^]*?\.spawn\(\)/,
);
assert.match(instance, /Command::new\("\/usr\/bin\/ditto"\)/);
assert.match(instance, /fs::create_dir\(&layout\.destination_dir\)/);
assert.match(instance, /\.kaigen-auto-install-incomplete/);
assert.match(instance, /name != "Kaigen-portable"/);
assert.match(instance, /requires the complete Kaigen-portable folder/);
assert.match(
  instance,
  /if layout\.destination_dir\.exists\(\) \{\s*return validate_portable_dir\(&layout\.destination_dir\);\s*\}/,
);
assert.match(macGuide, /двойном клике на Kaigen\.app внутри DMG/);
assert.match(macGuide, /никогда не[^]*перезаписывает существующие профили или данные/);
assert.match(macGuide, /существующая Kaigen\.app старее[^]*bootstrap её не заменяет/);

assert.match(tor, /command\.process_group\(0\)/);
assert.match(tor, /executable\.canonicalize\(\)\.unwrap_or\(executable\)/);
assert.match(tor, /libc::SIGINT/);
assert.match(tor, /libc::SIGTERM/);
assert.match(tor, /libc::SIGKILL/);
assert.match(tor, /Ok\(format!\("\{prefix\}\{executable\}\{arguments\}"\)\)/);
assert.match(tor, /executable\.chars\(\)\.any\(char::is_whitespace\)/);
assert.match(tor, /command\.current_dir\(&bundle_dir\)/);
assert.match(tor, /"tor\/pluggable_transports\/"\.to_string\(\)/);

assert.match(appImageBuild, /usr\/bin\/Kaigen/);
assert.match(appImageBuild, /libayatana-appindicator3\.so/);
assert.match(appImageBuild, /packaging\/AppRun-linux\.sh/);
assert.match(appImageBuild, /KAIGEN_APPRUN_BACKEND_POLICY_V1/);
assert.match(appImageBuild, /bash "\$project_root\/scripts\/test-apprun-linux\.sh"/);
assert.match(appImageBuild, /bash "\$project_root\/scripts\/test-appimage-tool-cache\.sh"/);
assert.match(appImageBuild, /linuxdeploy_sha256='20eebde3c18ae2e44279bd624fc72482503aece216d5d77f10932235342f71c1'/);
assert.match(appImageBuild, /app_run_runtime_sha256='f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f'/);
assert.match(appImageBuild, /appimage_plugin_sha256='a45d3e227bc7f397e9cf6bfa4c9507494efa2293357b6e86690a3de2ca992e79'/);
assert.match(appImageBuild, /gstreamer_plugin_sha256='c107b49d84edbffc6ab226ed1007e0626a4f7aa2c3a36b7782bef62351d49e94'/);
assert.match(appImageBuild, /gtk_plugin_sha256='cb379f9b0733e9ad9f8bd78f8c2fa038aef2478523bb7d4c8e64ff6a1ea3501a'/);
assert.match(appImageBuild, /appimagetool_sha256='58d3047a420e1dfa365ef0ad495b728b56627803cb6b75ed816b7a4fa9713720'/);
assert.match(appImageBuild, /appimage_runtime_sha256='2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d'/);
assert.match(appImageBuild, /appimage_runtime_size='944632'/);
assert.match(appImageBuild, /appimage_runtime_digest_md5_offset='932096'/);
assert.match(appImageBuild, /appimage_runtime_digest_md5_length='16'/);
assert.match(appImageBuild, /appimage_runtime_digest_md5_layout='0e3900:000010'/);
assert.match(appImageBuild, /https:\/\/github\.com\/tauri-apps\/binary-releases\/releases\/download\/linuxdeploy\/linuxdeploy-x86_64\.AppImage/);
assert.match(appImageBuild, /https:\/\/github\.com\/tauri-apps\/binary-releases\/releases\/download\/apprun-old\/AppRun-x86_64/);
assert.match(appImageBuild, /https:\/\/github\.com\/linuxdeploy\/linuxdeploy-plugin-appimage\/releases\/download\/continuous\/linuxdeploy-plugin-appimage-x86_64\.AppImage/);
assert.match(appImageBuild, /https:\/\/raw\.githubusercontent\.com\/tauri-apps\/linuxdeploy-plugin-gstreamer\/master\/linuxdeploy-plugin-gstreamer\.sh/);
assert.match(appImageBuild, /https:\/\/raw\.githubusercontent\.com\/tauri-apps\/linuxdeploy-plugin-gtk\/master\/linuxdeploy-plugin-gtk\.sh/);
assert.match(appImageBuild, /https:\/\/github\.com\/AppImage\/type2-runtime\/releases\/download\/20251108\/runtime-x86_64/);
assert.match(appImageBuild, /curl --proto '=https' --tlsv1\.2 --fail --location --retry 4 --retry-all-errors --retry-delay 2/);
assert.match(appImageBuild, /printf '\\0\\0\\0' \| dd of="\$download_file" bs=1 seek=8 count=3 conv=notrunc status=none/);
const officialToolDownload = appImageBuild.indexOf("curl --proto '=https'");
const linuxdeployHeaderTransform = appImageBuild.indexOf("printf '\\0\\0\\0' | dd");
const downloadedToolTrust = appImageBuild.indexOf('require_sha256 "$download_file" "$expected"');
const downloadedToolInstall = appImageBuild.indexOf('mv -- "$download_file" "$destination"');
assert.ok(
  officialToolDownload >= 0 &&
    linuxdeployHeaderTransform > officialToolDownload &&
    downloadedToolTrust > linuxdeployHeaderTransform &&
    downloadedToolInstall > downloadedToolTrust,
  "official fallback tools must be downloaded to a temporary file, transformed, hash-verified, then atomically installed",
);
assert.match(appImageBuild, /is_exact_pinned_tool "\$source_file" "\$expected"/);
assert.match(appImageBuild, /Reused pinned Tauri \$description from the read-only global cache/);
assert.match(appImageBuild, /Refusing non-HTTPS Tauri tool URL/);
assert.match(appImageBuild, /\.kaigen-tauri-cache\.XXXXXX/);
assert.match(appImageBuild, /install -p -m 0555 "\$source_file" "\$destination"/);
assert.match(appImageBuild, /Unexpected entry in isolated Tauri cache/);
assert.match(appImageBuild, /chmod 0555 "\$tauri_cache_root"/);
assert.match(appImageBuild, /export LDAI_RUNTIME_FILE="\$tauri_cache_root\/runtime-x86_64"/);
assert.match(appImageBuild, /require_appimage_runtime_digest_layout/);
assert.match(appImageBuild, /normalize_appimage_runtime_prefix/);
const preparePinnedCache = appImageBuild.indexOf("\nprepare_pinned_tauri_cache\n");
const tauriAppImageBuild = appImageBuild.indexOf("npm run tauri -- build");
const preTauriCacheVerify = appImageBuild.indexOf('verify_pinned_tauri_cache "$tauri_cache_root" exact', preparePinnedCache);
const postTauriCacheVerify = appImageBuild.indexOf('verify_pinned_tauri_cache "$tauri_cache_root" exact', tauriAppImageBuild);
const pinnedRuntimeExport = appImageBuild.indexOf('export LDAI_RUNTIME_FILE="$tauri_cache_root/runtime-x86_64"');
assert.ok(
  preparePinnedCache >= 0 &&
    pinnedRuntimeExport >= 0 &&
    preTauriCacheVerify > preparePinnedCache &&
    preTauriCacheVerify < tauriAppImageBuild &&
    postTauriCacheVerify > tauriAppImageBuild,
  "all isolated pinned Tauri Linux tools must be verified immediately before and after Tauri executes them",
);
assert.match(appImageBuild, /appimages=\("\$appimage_dir"\/\*\.AppImage\)/);
assert.match(appImageBuild, /\[\[ \$\{#appimages\[@\]\} -ne 1 \]\]/);
assert.match(appImageBuild, /Tauri AppImage must be a regular executable file/);
assert.match(appImageBuild, /refusing recursive repack/);
assert.match(appImageBuild, /Generated GTK hook no longer contains exactly one known GDK_BACKEND=x11 assignment/);
assert.ok(
  appImageBuild.includes(
    "grep -Ec '^[[:space:]]*export[[:space:]]+GDK_BACKEND=x11([[:space:]]+#[[:print:][:space:]]*)?[[:space:]]*$'",
  ),
  "the generated GTK hook guard must accept only a shell assignment with optional trailing comment",
);
assert.match(appImageBuild, /count_known_gdk_x11_assignment_lines "\$generated_gtk_hook"/);
assert.doesNotMatch(appImageBuild, /count_exact_line 'export GDK_BACKEND=x11'/);
assert.match(appImageBuild, /require_sha256 "\$appdir\/AppRun\.wrapped" "\$app_run_runtime_sha256"/);
assert.match(appImageBuild, /AppRun\.wrapped resolves outside AppDir/);
assert.match(appImageBuild, /AppRun\.wrapped has a recursive or ambiguous target/);
assert.match(appImageBuild, /count_exact_line 'Exec=Kaigen'/);
assert.match(appImageBuild, /cmp -s "\$app_run_template" "\$appdir\/AppRun"/);
assert.match(appImageBuild, /appimagetool_real="\$plugin_appdir\/appimagetool-prefix\/usr\/bin\/appimagetool"/);
assert.doesNotMatch(appImageBuild, /\$plugin_appdir\/usr\/bin\/appimagetool-prefix\/usr\/bin\/appimagetool/);
assert.match(appImageBuild, /verify_pinned_appimagetool_layout "\$plugin_appdir"/);
assert.match(appImageBuild, /--runtime-file "\$runtime_file"/);
const runtimeTrust = appImageBuild.indexOf('require_sha256 "$runtime_file" "$appimage_runtime_sha256"');
const tauriRuntimeTrust = appImageBuild.indexOf('require_sha256 "$tauri_runtime_normalized" "$appimage_runtime_sha256"');
const originalRuntimeExecution = appImageBuild.indexOf('reported_runtime_offset="$("$appimage" --appimage-offset)"');
const toolTrust = appImageBuild.indexOf('require_sha256 "$appimagetool_real" "$appimagetool_sha256"');
const toolExecution = appImageBuild.indexOf('ARCH=x86_64 "$appimagetool_wrapper"');
const finalExtractionVerification = appImageBuild.indexOf('verify_kaigen_appdir "$patched_extract/squashfs-root"');
const atomicMove = appImageBuild.indexOf('mv -f -- "$patched_appimage" "$appimage"');
assert.ok(
  runtimeTrust >= 0 &&
    tauriRuntimeTrust > runtimeTrust &&
    tauriRuntimeTrust < originalRuntimeExecution,
  "the Tauri output must match the pinned runtime outside the verified .digest_md5 section before its runtime is executed",
);
assert.ok(toolTrust >= 0 && toolTrust < toolExecution);
assert.ok(finalExtractionVerification >= 0 && finalExtractionVerification < atomicMove);
assert.match(appImageBuild, /cmp -s "\$tauri_runtime_normalized" "\$patched_runtime_normalized"/);
assert.match(appImageBuild, /Tauri transformed AppImage runtime SHA-256/);
assert.match(appImageBuild, /Repacked transformed AppImage runtime SHA-256/);
assert.match(appImageBuild, /patched_device="\$\(stat -c %d "\$patched_appimage"\)"/);
assert.match(appImageBuild, /destination_device="\$\(stat -c %d "\$appimage_dir"\)"/);
assert.match(appImageCacheTest, /run_prepare_case reuse/);
assert.match(appImageCacheTest, /run_prepare_case missing/);
assert.match(appImageCacheTest, /run_prepare_case mismatch/);
assert.match(appImageCacheTest, /Missing-cache fallback mutated the global Tauri cache/);
assert.match(appImageCacheTest, /Mismatch fallback mutated the global Tauri cache/);
assert.match(appImageCacheTest, /Pinned AppImage runtime was not exported through LDAI_RUNTIME_FILE/);
assert.match(appImageCacheTest, /KAIGEN_FAKE_CURL_CORRUPT_NAME=runtime-x86_64/);
assert.match(appImageCacheTest, /Corrupt downloaded AppImage runtime was accepted/);
assert.match(appImageCacheTest, /Runtime normalization did not restore the pinned prefix/);
assert.match(appImageCacheTest, /Runtime normalization accepted a change outside \.digest_md5/);
assert.match(appImageCacheTest, /KAIGEN_FAKE_CURL_MODE=corrupt/);
assert.match(appImageCacheTest, /Official commented GDK_BACKEND=x11 assignment was rejected/);
assert.match(appImageCacheTest, /Missing GDK_BACKEND=x11 assignment was accepted/);
assert.match(appImageCacheTest, /Duplicate GDK_BACKEND=x11 assignments were not detected/);
assert.match(appImageCacheTest, /Arbitrary GDK_BACKEND=x11 assignment suffix was accepted/);
assert.match(appImageCacheTest, /Pinned appimagetool layout resolver did not select the actual extracted hierarchy/);
assert.match(appImageCacheTest, /Obsolete nested appimagetool hierarchy was accepted/);
assert.match(appImageCacheTest, /Symlinked appimagetool wrapper was accepted/);
assert.match(appImageCacheTest, /Mismatched appimagetool ELF hash was accepted/);
assert.match(appImageCacheTest, /Non-ELF appimagetool payload was accepted/);
assert.match(windowsBuild, /target\\release\\Kaigen\.exe/);
assert.ok(
  unixBuildScripts.every(
    (buildScript) =>
      buildScript.includes("write_source_byte_manifest") &&
      buildScript.includes(".git") &&
      buildScript.includes("node_modules") &&
      buildScript.includes("src-tauri/target") &&
      buildScript.includes('-path "$project_root/src-tauri/gen/schemas"') &&
      !buildScript.includes('-path "$project_root/src-tauri/gen" -o') &&
      buildScript.includes(".kaigen-lab-source"),
  ),
  "Debian and macOS builds must byte-hash source files while pruning only known generated trees and the lab marker",
);
assert.ok(
  unixBuildScripts.every(
    (buildScript) =>
      buildScript.includes('project_root="$(cd "$(dirname "$0")/.." && pwd -P)"') &&
      buildScript.includes('artifacts_dir="$(mkdir -p "$artifacts_dir" && cd "$artifacts_dir" && pwd -P)"') &&
      buildScript.includes('"$project_root") echo "Artifacts directory must not equal the project root"') &&
      buildScript.includes('"$project_root"/*) in_project_artifacts="$artifacts_dir"') &&
      buildScript.includes('"$source_path" == "$in_project_artifacts" || "$source_path" == "$in_project_artifacts"/*'),
  ),
  "an exact resolved in-project artifacts descendant may be excluded, but the project root and sibling paths must remain guarded",
);
assert.ok(
  unixBuildScripts.every((buildScript) => {
    const baseline = buildScript.indexOf('write_source_byte_manifest "$source_manifest_before"');
    const prepare = buildScript.indexOf("prepare-unix-dependencies.sh");
    const tauriBuild = buildScript.indexOf("npm run tauri -- build");
    const firstPostBuild = buildScript.indexOf('write_source_byte_manifest "$source_manifest_after"', tauriBuild);
    const packageOutput = [buildScript.indexOf('appimage_dir="$project_root/src-tauri/target/release/bundle/appimage"'), buildScript.indexOf('built_app="$(find')].find((offset) => offset >= 0);
    const packageArchive = [buildScript.indexOf("zip -9 -q -r"), buildScript.indexOf("ditto -c -k")].find((offset) => offset >= 0);
    const finalGuard = buildScript.lastIndexOf('write_source_byte_manifest "$source_manifest_after"');
    return baseline >= 0 && baseline < prepare && tauriBuild < firstPostBuild && firstPostBuild < packageOutput && packageArchive < finalGuard;
  }),
  "Unix source guards must run before build work, before portable packaging, and again after archive creation",
);

const unixDirtyBaseline = new Map([
  ["src/already-dirty.ts", "dirty-before-build"],
  ["artifacts-neighbor/source.ts", "neighbor-before-build"],
  ["src-tauri/gen/android/app/src/main.rs", "mobile-source"],
]);
const unixGeneratedOnly = new Map(unixDirtyBaseline);
unixGeneratedOnly.set("artifacts/Kaigen.zip", "generated-output");
unixGeneratedOnly.set("node_modules/generated.js", "ignored-output");
unixGeneratedOnly.set("src-tauri/gen/schemas/desktop-schema.json", "generated-schema");
const unixNeighborMutation = new Map(unixGeneratedOnly);
unixNeighborMutation.set("artifacts-neighbor/source.ts", "neighbor-mutated-during-build");
const unixMobileMutation = new Map(unixGeneratedOnly);
unixMobileMutation.set("src-tauri/gen/android/app/src/main.rs", "mobile-source-mutated-during-build");
assert.deepEqual(
  {
    exactInTreeArtifact: changedManifestPaths(
      unixGuardedByteManifest(unixDirtyBaseline),
      unixGuardedByteManifest(unixGeneratedOnly),
    ),
    neighboringSourceMutation: changedManifestPaths(
      unixGuardedByteManifest(unixDirtyBaseline),
      unixGuardedByteManifest(unixNeighborMutation),
    ),
    generatedSchemas: changedManifestPaths(
      unixGuardedByteManifest(unixDirtyBaseline),
      unixGuardedByteManifest(unixGeneratedOnly),
    ),
    neighboringMobileSourceMutation: changedManifestPaths(
      unixGuardedByteManifest(unixDirtyBaseline),
      unixGuardedByteManifest(unixMobileMutation),
    ),
  },
  {
    exactInTreeArtifact: [],
    neighboringSourceMutation: ["artifacts-neighbor/source.ts"],
    generatedSchemas: [],
    neighboringMobileSourceMutation: ["src-tauri/gen/android/app/src/main.rs"],
  },
  "the Unix guard fixture must allow exact generated artifacts and schemas while rejecting neighboring source and mobile mutations",
);

assert.match(macBuild, /Contents\/Helpers\/kaigen-tor/);
assert.match(macBuild, /Contents\/Frameworks\/libevent-2\.1\.7\.dylib/);
assert.match(macBuild, /CFBundleExecutable/);
assert.match(macBuild, /executable_name" != 'Kaigen'/);
assert.match(macBuild, /for component in/);
assert.doesNotMatch(macBuild, /codesign --force --deep --sign/);
assert.match(macBuild, /KAIGEN_NOTARYTOOL_PROFILE/);
assert.match(macBuild, /KAIGEN_MACOS_DISTRIBUTION_MODE:-unsigned-test/);
assert.match(macBuild, /distribution mode requires KAIGEN_CODESIGN_IDENTITY/);
assert.match(macBuild, /distribution mode requires KAIGEN_NOTARYTOOL_PROFILE/);
assert.match(macBuild, /Authority=Developer ID Application:/);
assert.match(macBuild, /Kaigen-portable-macos-universal-UNSIGNED-TEST/);
assert.match(macBuild, /UNSIGNED TEST ARTIFACT.+not release-ready/);
assert.match(macBuild, /notarytool submit/);
assert.match(macBuild, /stapler staple/);
assert.match(macBuild, /dmg_root\/Kaigen-portable\/Kaigen\.app/);
assert.match(macBuild, /ln -s \/Applications "\$dmg_root\/Applications"/);

assert.match(unixWorkflow, /KAIGEN_MACOS_CERTIFICATE_P12_BASE64/);
assert.match(unixWorkflow, /KAIGEN_MACOS_NOTARY_KEY_P8_BASE64/);
assert.match(unixWorkflow, /github\.event_name != 'pull_request'/);
assert.match(unixWorkflow, /KAIGEN_MACOS_DISTRIBUTION_MODE=unsigned-test/);
assert.match(unixWorkflow, /KAIGEN_MACOS_DISTRIBUTION_MODE=distribution/);
assert.match(unixWorkflow, /macOS distribution build is fail-closed/);
assert.match(unixWorkflow, /missing repository secrets:[^]*exit 1/);
assert.doesNotMatch(unixWorkflow, /missing repository secrets:[^]*exit 0/);
assert.match(unixWorkflow, /name: Kaigen-portable-macos-universal-UNSIGNED-TEST/);
assert.match(unixWorkflow, /path: artifacts\/Kaigen-portable-macos-universal-UNSIGNED-TEST\.zip/);
assert.match(unixWorkflow, /name: Upload signed and notarized macOS distribution artifact[^]*github\.event_name != 'pull_request'[^]*path: artifacts\/Kaigen-portable-macos-universal\.zip/);
assert.equal(
  (unixWorkflow.match(/name: Kaigen-portable-macos-universal-UNSIGNED-TEST/g) ?? []).length,
  1,
  "the workflow must expose exactly one explicitly unsigned macOS artifact",
);
assert.equal(
  (unixWorkflow.match(/name: Kaigen-portable-macos-universal(?:\r?\n)/g) ?? []).length,
  1,
  "the workflow must expose the distribution artifact name only once",
);

assert.match(linuxGuide, /WEBKIT_DISABLE_DMABUF_RENDERER=1/);
assert.match(linuxGuide, /Wayland/);
assert.match(linuxGuide, /GDK_BACKEND/);
assert.match(linuxGuide, /gnome-shell-extension-appindicator/);
assert.match(platformGuide, /AppRun/);
assert.match(platformGuide, /GDK_BACKEND/);
assert.match(platformGuide, /чистом builder/);
assert.match(platformGuide, /глобальн[^]*cache[^]*не измен/);

console.log("Platform runtime and packaging contracts passed.");
