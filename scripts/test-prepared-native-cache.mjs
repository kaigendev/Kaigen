import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  canonicalizeContract,
  computeFingerprint,
  extractRecipeDescriptor,
  importEntry,
  materializedGitTree,
  parseOtoolLoadDependencies,
  promoteEntry,
  restoreEntry,
} from "./prepared-native-cache.mjs";

const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), "kaigen-prepared-cache-test-")));
const validateFixture = async () => {};
const fixtureContract = (consumer = "debian-desktop", toolchain = "same-linux-toolchain") => ({
  schema: "2",
  policy: "verified-prepared-native-v2",
  platform: "linux-x86_64",
  group: "tor-universal",
  architecture: "x86_64",
  abi: "linux-gnu",
  deployment_target: "host-glibc-exact",
  consumer,
  toolchain,
  "input.tor.filename": "tor-expert-bundle-linux-x86_64-15.0.20.tar.gz",
  "input.tor.size": "32211167",
  "input.tor.sha256": "3b39a2a7fbf43ef28b9ae0a6afca02a12935232f81769e4fef7472d6b5676eaf",
  "output.contract": "tor-expert-bundle-linux-x86_64-v2",
});

async function writeFixture(directory, payload) {
  await mkdir(path.join(directory, "tor", "pluggable_transports"), { recursive: true });
  await writeFile(path.join(directory, "tor", "tor"), payload);
  await writeFile(path.join(directory, "tor", "pluggable_transports", "lyrebird"), "lyrebird");
  await writeFile(path.join(directory, "tor", "pluggable_transports", "conjure-client"), "conjure");
}

async function makeWritable(directory) {
  const { lstat, readdir } = await import("node:fs/promises");
  const item = await lstat(directory).catch(() => null);
  if (!item) return;
  if (item.isDirectory()) {
    await chmod(directory, 0o755);
    for (const child of await readdir(directory)) await makeWritable(path.join(directory, child));
  } else await chmod(directory, 0o644);
}

function normalizedFixtureTree(repository) {
  execFileSync("git", ["-C", repository, "add", "--all"]);
  const staged = execFileSync("git", ["-C", repository, "ls-files", "--stage", "-z"], { encoding: "utf8" });
  for (const entry of staged.split("\0")) {
    if (!entry) continue;
    const match = /^(\d+) ([a-f0-9]{40,64}) (\d+)\t([\s\S]+)$/.exec(entry);
    assert.ok(match, "fixture Git index entry must be parseable");
    const [, mode, object, stage, filename] = match;
    assert.equal(stage, "0");
    if (mode === "100755" || mode === "120000") {
      execFileSync("git", ["-C", repository, "update-index", "--cacheinfo", `100644,${object},${filename}`]);
    }
  }
  return execFileSync("git", ["-C", repository, "write-tree"], { encoding: "utf8" }).trim();
}

try {
  const safeOtool = "/Users/kaigen/run/work/libtoxcore.dylib:\n\t@rpath/libtoxcore.2.dylib (compatibility version 2.0.0, current version 2.23.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)";
  assert.doesNotMatch(parseOtoolLoadDependencies(safeOtool), /\/Users\//,
    "the inspected absolute filename header is not a load dependency");
  const unsafeOtool = `${safeOtool}\n\t/Users/kaigen/run/work/libsodium.dylib (compatibility version 1.0.0, current version 1.0.0)`;
  assert.match(parseOtoolLoadDependencies(unsafeOtool), /\/Users\/kaigen\/run\/work\//,
    "actual absolute dependency lines remain visible to the validator");

  const cacheRoot = path.join(root, "cache");
  const producer = path.join(root, "debian-installed-output");
  await writeFixture(producer, "tor-binary-v1");

  // Consumer names are receipt metadata, not fingerprint inputs. The actual
  // Debian/Web contract must be byte-identical to share one Linux entry.
  const debianContract = fixtureContract();
  const webContract = { ...debianContract };
  delete debianContract.consumer;
  delete webContract.consumer;
  assert.equal(canonicalizeContract(debianContract), canonicalizeContract(webContract));
  assert.equal(computeFingerprint(debianContract), computeFingerprint(webContract));

  const promoted = await promoteEntry({ cacheRoot, contract: debianContract, source: producer, validateOutputs: validateFixture });
  assert.equal(promoted.disposition, "built");
  assert.match(promoted.fingerprint, /^[a-f0-9]{64}$/);
  assert.match(promoted.outputManifestSha256, /^[a-f0-9]{64}$/);

  const webDestination = path.join(root, "web-installed-output");
  const restored = await restoreEntry({ cacheRoot, contract: webContract, destination: webDestination, validateOutputs: validateFixture });
  assert.equal(restored.disposition, "hit");
  assert.equal(restored.fingerprint, promoted.fingerprint);
  assert.equal(await readFile(path.join(webDestination, "tor", "tor"), "utf8"), "tor-binary-v1");

  const webPhysicalCache = path.join(root, "web-physical-cache");
  const imported = await importEntry({
    sourceCacheRoot: cacheRoot,
    cacheRoot: webPhysicalCache,
    contract: webContract,
    validateOutputs: validateFixture,
  });
  assert.equal(imported.disposition, "hit", "an exact immutable Debian entry is a Web consumer hit");
  assert.equal(imported.physicalDisposition, "imported");
  assert.equal(imported.fingerprint, promoted.fingerprint);
  assert.equal(imported.outputManifestSha256, promoted.outputManifestSha256);
  const importedAgain = await importEntry({
    sourceCacheRoot: cacheRoot,
    cacheRoot: webPhysicalCache,
    contract: webContract,
    validateOutputs: validateFixture,
  });
  assert.equal(importedAgain.disposition, "hit");
  assert.equal(importedAgain.physicalDisposition, "already-present");

  const mismatchedContract = { ...webContract, toolchain: "different-web-toolchain" };
  assert.notEqual(computeFingerprint(mismatchedContract), promoted.fingerprint);
  await assert.rejects(
    restoreEntry({ cacheRoot, contract: mismatchedContract, destination: path.join(root, "must-not-exist"), validateOutputs: validateFixture }),
    /Prepared-cache miss/,
  );

  const conflicting = path.join(root, "conflicting-output");
  await writeFixture(conflicting, "different-bytes");
  await assert.rejects(
    promoteEntry({ cacheRoot, contract: debianContract, source: conflicting, validateOutputs: validateFixture }),
    /Same fingerprint produced different outputs/,
  );

  const entry = path.join(cacheRoot, "schema-2", "linux-x86_64", "tor-universal", promoted.fingerprint);
  const cachedTor = path.join(entry, "outputs", "tor", "tor");
  await chmod(cachedTor, 0o644);
  await writeFile(cachedTor, "corrupt");
  const preserved = path.join(root, "preserved-destination");
  await writeFixture(preserved, "preserve-me");
  await assert.rejects(
    restoreEntry({ cacheRoot, contract: debianContract, destination: preserved, validateOutputs: validateFixture }),
    /Corrupt prepared-cache manifest or output/,
  );
  assert.equal(await readFile(path.join(preserved, "tor", "tor"), "utf8"), "preserve-me");

  const revokedCache = path.join(root, "revoked-cache");
  const revokedContract = { ...webContract, toolchain: "revoked-toolchain" };
  const revoked = await promoteEntry({ cacheRoot: revokedCache, contract: revokedContract, source: producer, validateOutputs: validateFixture });
  const tombstoneRoot = path.join(revokedCache, "schema-2", "revoked");
  await mkdir(tombstoneRoot, { recursive: true });
  await writeFile(path.join(tombstoneRoot, `${revoked.fingerprint}.json`), "{}\n");
  await assert.rejects(
    restoreEntry({ cacheRoot: revokedCache, contract: revokedContract, destination: path.join(root, "revoked-destination"), validateOutputs: validateFixture }),
    /is revoked/,
  );

  const staleIndexSource = path.join(root, "stale-index-source");
  await mkdir(staleIndexSource);
  execFileSync("git", ["-C", staleIndexSource, "init", "-q"]);
  await writeFile(path.join(staleIndexSource, "tracked.txt"), "old\n");
  execFileSync("git", ["-C", staleIndexSource, "add", "--all"]);
  const staleTree = execFileSync("git", ["-C", staleIndexSource, "write-tree"], { encoding: "utf8" }).trim();
  await writeFile(path.join(staleIndexSource, "tracked.txt"), "new\n");
  const actualWorkingTree = await materializedGitTree(staleIndexSource);
  assert.notEqual(actualWorkingTree, staleTree, "bootstrap must hash current working bytes, not a stale producer index");
  const expectedWorkingTree = normalizedFixtureTree(staleIndexSource);
  assert.equal(actualWorkingTree, expectedWorkingTree,
    "materialized source hashing must use the copied source root, not an existing temporary wrapper directory");
  if (process.platform !== "win32") {
    const symlinkSource = path.join(root, "relative-symlink-source");
    await mkdir(path.join(symlinkSource, "target"), { recursive: true });
    await writeFile(path.join(symlinkSource, "target", "value.txt"), "value\n");
    await symlink("target/value.txt", path.join(symlinkSource, "relative-link"));
    execFileSync("git", ["-C", symlinkSource, "init", "-q"]);
    const expectedSymlinkTree = normalizedFixtureTree(symlinkSource);
    assert.equal(await materializedGitTree(symlinkSource), expectedSymlinkTree,
      "materialized source hashing must preserve relative symlink bytes verbatim");
  }

  const sourceRoot = new URL("../", import.meta.url);
  const prepare = await readFile(new URL("scripts/prepare-unix-dependencies.sh", sourceRoot), "utf8");
  const macBuild = await readFile(new URL("scripts/build-macos.sh", sourceRoot), "utf8");
  const debianBuild = await readFile(new URL("scripts/build-appimage.sh", sourceRoot), "utf8");
  const webBuild = await readFile(new URL("scripts/build-web-installer.ps1", sourceRoot), "utf8");
  const windowsBuild = await readFile(new URL("scripts/build-portable.ps1", sourceRoot), "utf8");
  const windowsCache = await readFile(new URL("scripts/prepared-native-cache-windows.ps1", sourceRoot), "utf8");
  const cacheTool = await readFile(new URL("scripts/prepared-native-cache.mjs", sourceRoot), "utf8");
  assert.match(cacheTool, /verbatimSymlinks: true/,
    "cross-platform source proof must preserve symlink targets verbatim");
  const consumers = [];
  if (windowsBuild.includes("Resolve-KaigenPreparedNativeGroup") && windowsCache.includes("windows-x64")) consumers.push("Windows");
  if (debianBuild.includes('prepare-unix-dependencies.sh" linux') && debianBuild.includes("work/platform/linux/toxcore/lib")) consumers.push("Debian");
  if (webBuild.includes("work/platform/linux/toxcore/lib") && webBuild.includes("work/platform/linux/TorExpertBundle")) consumers.push("Web");
  if (macBuild.includes('prepare-unix-dependencies.sh" macos') && cacheTool.includes('"macos-universal"')) consumers.push("macOS");
  assert.deepEqual(consumers.sort(), ["Debian", "Web", "Windows", "macOS"].sort(),
    "prepared-native reuse must have exactly the four requested desktop/Web consumers");
  assert.doesNotMatch(`${prepare}\n${cacheTool}\n${windowsCache}`, /\b(?:android|ios|mobile)\b/i,
    "prepared-native cache scope must not silently expand to mobile targets");
  const recipeHash = (group, platform, script) => createHash("sha256")
    .update(extractRecipeDescriptor(script, group, platform)).digest("hex");
  for (const platform of ["macos-universal", "linux-x86_64"]) {
    for (const group of ["libsodium", "c-toxcore", "tor-universal"]) {
      assert.equal(
        recipeHash(group, platform, prepare),
        recipeHash(group, platform, `# orchestration-only change\n${prepare}`),
        `orchestration-only edits must not invalidate ${platform}/${group}`,
      );
    }
    const cToxRecipeChanged = prepare.replace("-DAUTOTEST=OFF", "-DAUTOTEST=ON");
    assert.throws(
      () => extractRecipeDescriptor(cToxRecipeChanged, "c-toxcore", platform),
      /recipe extraction failed/,
      `unrecognised c-toxcore recipe changes must fail closed for ${platform}`,
    );
    for (const unaffectedGroup of ["libsodium", "tor-universal"]) {
      const before = {
        ...fixtureContract(),
        platform,
        group: unaffectedGroup,
        "script.preparation_recipe.sha256": recipeHash(unaffectedGroup, platform, prepare),
      };
      const after = {
        ...before,
        "script.preparation_recipe.sha256": recipeHash(unaffectedGroup, platform, cToxRecipeChanged),
      };
      assert.equal(
        computeFingerprint(before), computeFingerprint(after),
        `a c-toxcore-only recipe change must not invalidate ${platform}/${unaffectedGroup}`,
      );
    }
    assert.throws(
      () => extractRecipeDescriptor(
        prepare.replace('cp -L "$tox_candidate" "$tox_prefix/lib/$(basename "$tox_candidate")"',
          'cp "$tox_candidate" "$tox_prefix/lib/$(basename "$tox_candidate")"'),
        "c-toxcore", platform,
      ),
      /recipe extraction failed/,
      `c-toxcore output materialisation changes must fail closed for ${platform}`,
    );
  }
  assert.match(prepare, /KAIGEN_PREPARED_NATIVE_CACHE_MODE:-expected-hit/);
  assert.match(prepare, /prepared-native-cache-receipt\.jsonl/);
  assert.match(prepare, /restore_prepared_group libsodium/);
  assert.match(prepare, /restore_prepared_group c-toxcore/);
  assert.match(prepare, /restore_prepared_group tor-universal/);
  assert.match(cacheTool, /cache\.transform\.sha256.*normalizeLibsodiumCachedOutput\.toString\(\)/,
    "libsodium output normalisation must have a group-scoped transform fingerprint");
  assert.match(cacheTool, /cache\.transform\.sha256.*normalizeCtoxcoreCachedOutput\.toString\(\).*macRpaths\.toString\(\)/s,
    "c-toxcore RPATH removal must have a group-scoped transform fingerprint");
  assert.match(cacheTool, /install_name_tool.*-delete_rpath/s);
  assert.match(cacheTool, /file\(RPATH_REMOVE FILE/);
  assert.match(cacheTool, /c-toxcore still has LC_RPATH entries/);
  assert.match(cacheTool, /RPATH\|RUNPATH/);
  assert.match(macBuild, /mode === 'expected-hit'.*entry\.disposition !== 'hit'/s);
  const freezeChildren = cacheTool.indexOf("await makeImmutable(stage, true)");
  const atomicPublish = cacheTool.indexOf("await rename(stage, entry)", freezeChildren);
  const freezePublishedRoot = cacheTool.indexOf("await chmod(entry, 0o555)", atomicPublish);
  assert.ok(freezeChildren >= 0 && freezeChildren < atomicPublish && atomicPublish < freezePublishedRoot,
    "macOS cache promotion must freeze children, atomically rename a writable stage root, then freeze the published root");
  const stagedCopy = cacheTool.indexOf('await cp(source, path.join(stage, "outputs")');
  const stagedWritable = cacheTool.indexOf('await makeWritable(path.join(stage, "outputs"))', stagedCopy);
  const stagedNormalize = cacheTool.indexOf('await normalizeCachedOutput(contract, path.join(stage, "outputs"))', stagedWritable);
  assert.ok(stagedCopy >= 0 && stagedCopy < stagedWritable && stagedWritable < stagedNormalize && stagedNormalize < freezeChildren,
    "immutable imported outputs must be made writable only inside staging before normalization and frozen before publish");
  const compareCopy = cacheTool.indexOf("await cp(source, comparison");
  const compareWritable = cacheTool.indexOf("await makeWritable(comparison)", compareCopy);
  const compareNormalize = cacheTool.indexOf("await normalizeCachedOutput(contract, comparison)", compareWritable);
  assert.ok(compareCopy >= 0 && compareCopy < compareWritable && compareWritable < compareNormalize,
    "same-fingerprint comparison must normalize only a writable temporary copy");

  console.log("prepared native cache regression: PASS");
} finally {
  await makeWritable(root).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
