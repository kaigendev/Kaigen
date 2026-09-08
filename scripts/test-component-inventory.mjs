import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const projectRoot = new URL("../", import.meta.url);
const { COMPONENT_VERSIONS: versions } = await importTypeScriptModule(new URL("src/componentVersions.ts", projectRoot));
const packageJson = JSON.parse(await readFile(new URL("package.json", projectRoot), "utf8"));
const packageLock = JSON.parse(await readFile(new URL("package-lock.json", projectRoot), "utf8"));
const tauriConfig = JSON.parse(await readFile(new URL("src-tauri/tauri.conf.json", projectRoot), "utf8"));
const cargoManifest = await readFile(new URL("src-tauri/Cargo.toml", projectRoot), "utf8");
const cargoLock = await readFile(new URL("src-tauri/Cargo.lock", projectRoot), "utf8");
const webCargoManifest = await readFile(new URL("web/kaigen-webd/Cargo.toml", projectRoot), "utf8");
const webCargoLock = await readFile(new URL("web/kaigen-webd/Cargo.lock", projectRoot), "utf8");
const cargoBuild = await readFile(new URL("src-tauri/build.rs", projectRoot), "utf8");
const windowsDependencies = await readFile(new URL("scripts/prepare-dependencies.ps1", projectRoot), "utf8");
const unixDependencies = await readFile(new URL("scripts/prepare-unix-dependencies.sh", projectRoot), "utf8");
const qtoxRuntime = await readFile(new URL("runtime/qtox-import/README.txt", projectRoot), "utf8");
const qtoxRuntimeDll = await readFile(new URL("runtime/qtox-import/libsqlcipher-0.dll", projectRoot));
const settings = await readFile(new URL("src/Settings.tsx", projectRoot), "utf8");
const notices = await readFile(new URL("THIRD_PARTY_NOTICES.md", projectRoot), "utf8");

function npmVersion(name) {
  return packageLock.packages?.[`node_modules/${name}`]?.version;
}

function cargoVersion(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return cargoLock.match(new RegExp(`\\[\\[package\\]\\]\\r?\\nname = "${escaped}"\\r?\\nversion = "([^"]+)"`, "u"))?.[1];
}

async function fileSha256(relativePath) {
  const contents = await readFile(new URL(relativePath, projectRoot));
  return createHash("sha256").update(contents).digest("hex").toUpperCase();
}

assert.equal(packageJson.version, versions.appManifest, "Desktop manifest version must match package.json");
assert.equal(packageLock.version, versions.appManifest, "Root package-lock version must match package.json");
assert.equal(packageLock.packages?.[""]?.version, versions.appManifest, "Package-lock root package must match package.json");
assert.equal(tauriConfig.version, versions.appManifest, "Tauri version must match the compatible manifest version");
assert.match(cargoManifest, new RegExp(`^version = "${versions.appManifest.replace("+", "\\+")}"$`, "m"));
assert.equal(cargoVersion("kaigen"), versions.appManifest, "Desktop Cargo.lock must match the compatible manifest version");
assert.match(webCargoManifest, new RegExp(`^version = "${versions.webBackendManifest.replace("+", "\\+")}"$`, "m"));
assert.match(webCargoLock, new RegExp(`\\[\\[package\\]\\]\\r?\\nname = "kaigen-webd"\\r?\\nversion = "${versions.webBackendManifest.replace("+", "\\+")}"`));
assert.equal(versions.appManifest.replace("+", "."), versions.app, "Public four-component label must map exactly to SemVer build metadata");
assert.equal(npmVersion("react"), versions.react, "About React version must match package-lock.json");
assert.equal(npmVersion("typescript"), versions.typescript, "About TypeScript version must match package-lock.json");
assert.equal(npmVersion("nspell"), versions.nspell, "About nspell version must match package-lock.json");
for (const [fontPackage, version, noticeName] of [
  ["@ibm/plex-sans-condensed", "2.0.0", "IBM Plex Sans Condensed"],
  ["@fontsource/fira-sans-condensed", "5.3.0", "Fira Sans Condensed"],
  ["@fontsource-variable/noto-sans", "5.3.0", "Noto Sans"],
  ["@fontsource/source-sans-3", "5.3.0", "Source Sans 3"],
  ["@fontsource/golos-text", "5.3.0", "Golos Text"],
  ["@fontsource/martian-mono", "5.3.0", "Martian Mono"],
  ["@fontsource/inter", "5.3.0", "Inter"],
  ["@fontsource/onest", "5.3.0", "Onest"],
]) {
  assert.equal(packageJson.dependencies[fontPackage], version, `${fontPackage} must remain an exact direct pin`);
  assert.equal(npmVersion(fontPackage), version, `${fontPackage} package-lock pin must match`);
  assert.ok(notices.includes(`${noticeName} ${version}`), `${noticeName} notice must ship with the portable build`);
}
assert.equal(cargoVersion("tauri"), versions.tauri, "About Tauri version must match Cargo.lock");
assert.match(cargoManifest, /^base64 = "0\.22\.1"$/m, "PQv2 needs the pinned base64 dependency in the shared core");
assert.doesNotMatch(
  cargoManifest,
  /^web-core = \[[^\]]*dep:base64/m,
  "base64 must not remain gated behind web-core while the shared PQ engine serializes wire records",
);
assert.ok(
  windowsDependencies.includes(`$ToxcoreCommit = "${versions.cToxcoreCommit}"`) &&
    windowsDependencies.includes("security-v4") &&
    windowsDependencies.includes("patch-manifest.json"),
);
assert.ok(
  unixDependencies.includes(`toxcore_commit="${versions.cToxcoreCommit}"`) &&
    unixDependencies.includes("security-v4") &&
    unixDependencies.includes("patch-manifest.json"),
);
assert.ok(windowsDependencies.includes(`$WebView2Version = "${versions.webView2}"`));
assert.ok(windowsDependencies.includes(`$TorBundleVersion = "${versions.torExpertBundle}"`));
assert.ok(unixDependencies.includes(`/torbrowser/${versions.torExpertBundle}"`));
assert.ok(notices.includes(`GeoIP/GeoIPv6: IPFire Location Database export от ${versions.torGeoIpDataset}`));
assert.ok(windowsDependencies.includes(`libsodium-${versions.libsodium}-msvc.zip`));
assert.ok(cargoBuild.includes(`vendor/mlkem-native-${versions.mlkemNative}/mlkem`));
assert.ok(
  cargoBuild.includes("KAIGEN_LIBSODIUM_LIB_DIR") &&
    cargoBuild.includes('println!("cargo:rustc-link-lib=static=libsodium")') &&
    cargoBuild.includes('println!("cargo:rustc-link-lib=static=sodium")') &&
    cargoBuild.includes("work/deps/libsodium/libsodium/x64/Release/v143/static") &&
    cargoBuild.includes('join("libsodium")'),
  "Kaigen X25519 must link the pinned prepared libsodium static library on every platform",
);
assert.ok(qtoxRuntime.includes(`SQLCipher ${versions.sqlcipherImportRuntime} / SQLite ${versions.sqliteImportRuntime}`));
assert.ok(qtoxRuntime.includes(`OpenSSL ${versions.opensslImportRuntime}`));
assert.equal(await fileSha256("runtime/qtox-import/libsqlcipher-0.dll"), "A69C768C63F8EF883419EB5B6C3CD41570A5D3F82650C6AC3E4A7F75BB4288D2");
for (const hostPathMarker of [":\\Users\\", "AppData\\Local\\Temp", "KaigenSqlcipherRebuild", "component-update-", "KaigenToxClient\\work\\"]) {
  assert.ok(
    !qtoxRuntimeDll.includes(Buffer.from(hostPathMarker, "utf8")) &&
      !qtoxRuntimeDll.includes(Buffer.from(hostPathMarker, "utf16le")),
    `qTox SQLCipher runtime must not embed build-host path marker: ${hostPathMarker}`,
  );
}
for (const obsolete of ["libcrypto-3-x64.dll", "libssl-3-x64.dll", "libgcc_s_seh-1.dll", "libstdc++-6.dll", "libwinpthread-1.dll"]) {
  await assert.rejects(access(new URL(`runtime/qtox-import/${obsolete}`, projectRoot)), undefined, `${obsolete} must not remain in the distribution`);
}
assert.ok(notices.includes(versions.hunspellDictionariesCommit));
assert.equal(await fileSha256("runtime/dictionaries/en-US.aff"), "8AE1F19D4840D957728AD90555D5A8DFF6CC5C046279C95FF0C00FC0A0136C7B");
assert.equal(await fileSha256("runtime/dictionaries/en-US.dic"), "F0B1A234BD178BDD01875B2A392A9647F888B8FE879F79C52AAE62C2759B3647");
assert.equal(await fileSha256("runtime/dictionaries/ru-RU.aff"), "38CE7D4AF78E211E9BAFE4BF7E3D6A2C420591136CB738EC6648F8FDF6524CD7");
assert.equal(await fileSha256("runtime/dictionaries/ru-RU.dic"), "F6047416A0204ADBECF3A451B874EC8A97EE37E2CBC714466EF04D8DBCC0D6FC");
assert.ok(settings.includes('import { COMPONENT_VERSIONS } from "./componentVersions"'));
assert.ok(!settings.includes("Kaigen 0.1.1"), "About must not retain the stale application version");
assert.ok(!settings.includes("ML-KEM native 1.3.0"), "About must not retain the replaced ML-KEM version");

console.log("component inventory: manifests, locks, native pins, and About are consistent");
