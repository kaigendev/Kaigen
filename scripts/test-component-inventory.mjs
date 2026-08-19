import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const projectRoot = new URL("../", import.meta.url);
const { COMPONENT_VERSIONS: versions } = await importTypeScriptModule(new URL("src/componentVersions.ts", projectRoot));
const packageJson = JSON.parse(await readFile(new URL("package.json", projectRoot), "utf8"));
const packageLock = JSON.parse(await readFile(new URL("package-lock.json", projectRoot), "utf8"));
const cargoLock = await readFile(new URL("src-tauri/Cargo.lock", projectRoot), "utf8");
const cargoBuild = await readFile(new URL("src-tauri/build.rs", projectRoot), "utf8");
const windowsDependencies = await readFile(new URL("scripts/prepare-dependencies.ps1", projectRoot), "utf8");
const unixDependencies = await readFile(new URL("scripts/prepare-unix-dependencies.sh", projectRoot), "utf8");
const qtoxRuntime = await readFile(new URL("runtime/qtox-import/README.txt", projectRoot), "utf8");
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

assert.equal(packageJson.version, versions.app, "About app version must match package.json");
assert.equal(npmVersion("react"), versions.react, "About React version must match package-lock.json");
assert.equal(npmVersion("typescript"), versions.typescript, "About TypeScript version must match package-lock.json");
assert.equal(npmVersion("nspell"), versions.nspell, "About nspell version must match package-lock.json");
assert.equal(cargoVersion("tauri"), versions.tauri, "About Tauri version must match Cargo.lock");
assert.ok(windowsDependencies.includes(`$ToxcoreCommit = "${versions.cToxcoreCommit}"`));
assert.ok(unixDependencies.includes(`toxcore_commit="${versions.cToxcoreCommit}"`));
assert.ok(windowsDependencies.includes(`$WebView2Version = "${versions.webView2}"`));
assert.ok(windowsDependencies.includes(`$TorBundleVersion = "${versions.torExpertBundle}"`));
assert.ok(unixDependencies.includes(`/torbrowser/${versions.torExpertBundle}"`));
assert.ok(notices.includes(`GeoIP/GeoIPv6: IPFire Location Database export от ${versions.torGeoIpDataset}`));
assert.ok(windowsDependencies.includes(`libsodium-${versions.libsodium}-msvc.zip`));
assert.ok(cargoBuild.includes(`vendor/mlkem-native-${versions.mlkemNative}/mlkem`));
assert.ok(qtoxRuntime.includes(`SQLCipher ${versions.sqlcipherImportRuntime} / SQLite ${versions.sqliteImportRuntime}`));
assert.ok(qtoxRuntime.includes(`OpenSSL ${versions.opensslImportRuntime}`));
assert.equal(await fileSha256("runtime/qtox-import/libsqlcipher-0.dll"), "CD045C07BF315B192ED98FCB655D08F9E8FB6D936456F52EBFC213DD219AF703");
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
