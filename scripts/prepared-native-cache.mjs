#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const POLICY = "verified-prepared-native-v2";
const SCHEMA = 2;
const GROUPS = new Set(["libsodium", "c-toxcore", "tor-universal"]);
const PLATFORMS = new Set(["macos-universal", "linux-x86_64"]);
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;

const COMPONENTS = Object.freeze({
  toxcore: {
    file: "c-toxcore-1d79022fb4e56dffe0bbd075d47e00f7a0b62ab3.zip",
    size: 1354914,
    sha256: "8764ec0e15448f2f76e1e0dcac15bbdac959d8519bd3e274d1126c302fb56506",
  },
  cmp: {
    file: "cmp-52bfcfa17d2eb4322da2037ad625f5575129cece.zip",
    size: 52550,
    sha256: "281bb25882e4186187df555775dd3cd57943ecfafc70b5d5076bec9dee02672d",
  },
  sodium: {
    file: "libsodium-1.0.22.tar.gz",
    size: 2268897,
    sha256: "729efdb75be22abed3ef31824674976af43008f900bad9b576ce412d6f659175",
    sourceTree: "d1013e5650282e1ddd0feb74d2e0d856fcb50b74069f3cc324eccf875f072452",
  },
  torLinux: {
    file: "tor-expert-bundle-linux-x86_64-15.0.20.tar.gz",
    size: 32211167,
    sha256: "3b39a2a7fbf43ef28b9ae0a6afca02a12935232f81769e4fef7472d6b5676eaf",
  },
  torMacX64: {
    file: "tor-expert-bundle-macos-x86_64-15.0.20.tar.gz",
    size: 19251761,
    sha256: "6ec3048b3a5d55e297f35d84830d0e338884d702aac3db49056633c1223841df",
  },
  torMacArm64: {
    file: "tor-expert-bundle-macos-aarch64-15.0.20.tar.gz",
    size: 18617670,
    sha256: "73fdccde8136678e41a625160993e6a9dc4f4ff8cd376318b5e41e5627d55682",
  },
});

class CacheMissError extends Error {}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(filename) {
  return hashBytes(await readFile(filename));
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key.slice(2))) {
      throw new Error(`Invalid argument list near ${key ?? "<end>"}`);
    }
    values.set(key.slice(2), value);
  }
  const required = (key) => {
    const value = values.get(key);
    if (!value) throw new Error(`Missing --${key}`);
    return value;
  };
  return { command, values, required };
}

async function ordinaryDirectory(directory, description) {
  const item = await lstat(directory).catch(() => null);
  if (!item?.isDirectory() || item.isSymbolicLink()) {
    throw new Error(`${description} must be an ordinary directory: ${directory}`);
  }
}

async function ordinaryFile(filename, description) {
  const item = await lstat(filename).catch(() => null);
  if (!item?.isFile() || item.isSymbolicLink()) {
    throw new Error(`${description} must be an ordinary file: ${filename}`);
  }
  return item;
}

async function assertComponent(inputRoot, component) {
  const filename = path.join(inputRoot, component.file);
  const item = await ordinaryFile(filename, "Component input");
  if (item.size !== component.size) {
    throw new Error(`Component size mismatch for ${component.file}: ${item.size}`);
  }
  const actual = await hashFile(filename);
  if (actual !== component.sha256) {
    throw new Error(`Component SHA-256 mismatch for ${component.file}: ${actual}`);
  }
  return filename;
}

function runExact(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Toolchain probe failed: ${command} ${args.join(" ")}`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.replace(/\r\n/g, "\n").trim();
}

function toolchain(platform, group) {
  const probes = platform === "macos-universal"
    ? [
        ["sw_vers", ["-productVersion"]], ["uname", ["-m"]], ["xcode-select", ["-p"]],
        ...(group === "tor-universal" ? [["xcrun", ["--find", "lipo"]]] : [
          ["clang", ["--version"]], ["ld", ["-v"]],
          ...(group === "libsodium" ? [["make", ["--version"]]] : []),
          ["xcrun", ["--sdk", "macosx", "--show-sdk-path"]],
          ["xcrun", ["--sdk", "macosx", "--show-sdk-version"]],
          ...(group === "c-toxcore" ? [
            ["cmake", ["--version"]], ["ninja", ["--version"]],
            ["xcrun", ["--find", "otool"]], ["xcrun", ["--find", "nm"]],
            ["xcrun", ["--find", "install_name_tool"]],
          ] : []),
        ]),
      ]
    : [
        ["uname", ["-m"]], ["tar", ["--version"]],
        ...(group === "tor-universal" ? [] : [
          ["cc", ["--version"]], ["ld", ["--version"]],
          ...(group === "libsodium" ? [["make", ["--version"]]] : []),
          ["ldd", ["--version"]],
          ...(group === "c-toxcore" ? [
            ["cmake", ["--version"]], ["ninja", ["--version"]],
            ["readelf", ["--version"]], ["nm", ["--version"]],
          ] : []),
        ]),
      ];
  return Object.fromEntries(probes.map(([command, args], index) => [
    `toolchain.${String(index + 1).padStart(2, "0")}.${command}`,
    hashBytes(`${command}\0${args.join("\0")}\0${runExact(command, args)}\n`),
  ]));
}

export function extractRecipeDescriptor(scriptText, group, platform) {
  if (!GROUPS.has(group) || !PLATFORMS.has(platform)) throw new Error("Unsupported native recipe group/platform");
  const macos = platform === "macos-universal";
  const selectors = group === "libsodium"
    ? [
        /^tar -xzf "\$sodium_archive" -C "\$source_dir"$/,
        /^cp -R "\$sodium_source" "\$sodium_build"$/,
        macos
          ? /^export CFLAGS="-O2 -fPIC -arch x86_64 -arch arm64 -mmacosx-version-min=11\.0"$/
          : /^export CFLAGS="-O2 -fPIC"$/,
        ...(macos ? [/^export LDFLAGS="-arch x86_64 -arch arm64 -mmacosx-version-min=11\.0"$/] : []),
        /^\.\/configure --prefix="\$sodium_prefix" --disable-shared --enable-static --with-pic$/,
        /^make -j"\$jobs"$/,
        /^make install$/,
      ]
    : group === "c-toxcore"
      ? [
          /^unzip -q "\$tox_archive" -d "\$source_dir\/tox-extract"$/,
          /^mv "\$source_dir\/tox-extract"\/\* "\$tox_source"$/,
          /^unzip -q "\$cmp_archive" -d "\$source_dir\/cmp-extract"$/,
          /^mv "\$source_dir\/cmp-extract"\/\* "\$tox_source\/third_party\/cmp"$/,
          /^apply_kaigen_toxcore_retry_cap "\$tox_source"$/,
          /^apply_kaigen_toxcore_security_v4 "\$tox_source"$/,
          /^export PKG_CONFIG_PATH="\$sodium_prefix\/lib\/pkgconfig\$\{PKG_CONFIG_PATH:\+:\$PKG_CONFIG_PATH\}"$/,
          /^-S "\$tox_source"$/,
          /^-B "\$tox_build"$/,
          /^-G Ninja$/,
          /^-DCMAKE_BUILD_TYPE=Release$/,
          /^-DBUILD_TOXAV=OFF$/,
          /^-DBOOTSTRAP_DAEMON=OFF$/,
          /^-DAUTOTEST=OFF$/,
          /^-DBUILD_SHARED_LIBS=ON$/,
          /^-DCMAKE_PREFIX_PATH="\$sodium_prefix"$/,
          /^-DCMAKE_INSTALL_PREFIX="\$tox_prefix"$/,
          ...(macos ? [
            /^'-DCMAKE_OSX_ARCHITECTURES=x86_64;arm64'$/,
            /^-DCMAKE_OSX_DEPLOYMENT_TARGET=11\.0$/,
            /^'-DCMAKE_INSTALL_NAME_DIR=@rpath'$/,
          ] : []),
          /^cmake "\$\{cmake_args\[@\]\}"$/,
          /^cmake --build "\$tox_build" --target toxcore_shared -j "\$jobs"$/,
          macos
            ? /^tox_library="\$\(find "\$tox_build" -name 'libtoxcore\.dylib' -print -quit\)"$/
            : /^tox_library="\$\(find "\$tox_build" -name 'libtoxcore\.so' -print -quit\)"$/,
          macos
            ? /^for tox_candidate in "\$\(dirname "\$tox_library"\)"\/libtoxcore\*\.dylib; do$/
            : /^for tox_candidate in "\$\(dirname "\$tox_library"\)"\/libtoxcore\.so\*; do$/,
          /^cp -L "\$tox_candidate" "\$tox_prefix\/lib\/\$\(basename "\$tox_candidate"\)"$/,
        ]
      : macos
        ? [
            /^tar -xzf "\$tor_x64_archive" -C "\$tor_x64_dir"$/,
            /^tar -xzf "\$tor_arm_archive" -C "\$tor_arm_dir"$/,
            /^cp -R "\$tor_arm_dir" "\$tor_universal_dir"$/,
            /^tor\/tor \\$/,
            /^tor\/libevent-2\.1\.7\.dylib \\$/,
            /^tor\/pluggable_transports\/lyrebird \\$/,
            /^tor\/pluggable_transports\/conjure-client; do$/,
            /^lipo -create "\$tor_x64_dir\/\$relative" "\$tor_arm_dir\/\$relative" \\$/,
            /^-output "\$merged"$/,
            /^mv "\$merged" "\$tor_universal_dir\/\$relative"$/,
            /^chmod \+x "\$tor_universal_dir\/\$relative"$/,
          ]
        : [
            /^tar -xzf "\$tor_archive" -C "\$platform_dir\/TorExpertBundle"$/,
            /^rm -rf "\$platform_dir\/TorExpertBundle\/debug"$/,
            /^chmod \+x "\$platform_dir\/TorExpertBundle\/tor\/tor" \\$/,
            /^"\$platform_dir\/TorExpertBundle\/tor\/pluggable_transports\/lyrebird" \\$/,
            /^"\$platform_dir\/TorExpertBundle\/tor\/pluggable_transports\/conjure-client"$/,
          ];
  const normalized = scriptText.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim());
  let expectedSelectedLines = 0;
  for (const selector of selectors) {
    const matches = normalized.filter((line) => selector.test(line));
    // The same output-copy statement exists in the mutually exclusive Linux
    // and macOS branches. Both spellings must remain exact.
    const expectedCount = selector.source.startsWith("^cp -L") ? 2 : 1;
    if (matches.length !== expectedCount) throw new Error(`Native recipe extraction failed for ${group}/${platform}: ${selector}`);
    expectedSelectedLines += expectedCount;
  }
  const selected = normalized.filter((line) => selectors.some((selector) => selector.test(line)));
  if (selected.length !== expectedSelectedLines) throw new Error(`Native recipe extraction is ambiguous for ${group}/${platform}`);
  return `${selected.join("\n")}\n`;
}

async function contractFor({ platform, group, projectRoot, inputRoot, prepareScript, cacheTool }) {
  if (!PLATFORMS.has(platform) || !GROUPS.has(group)) throw new Error("Unsupported platform/group");
  await ordinaryDirectory(projectRoot, "Project root");
  await ordinaryDirectory(inputRoot, "Component input root");
  await ordinaryFile(prepareScript, "Preparation script");
  await ordinaryFile(cacheTool, "Cache tool");
  const prepareText = await readFile(prepareScript, "utf8");
  const recipe = extractRecipeDescriptor(prepareText, group, platform);
  const recipeSha = hashBytes(recipe);
  const common = {
    schema: String(SCHEMA),
    policy: POLICY,
    platform,
    group,
    architecture: platform === "macos-universal" ? "x86_64+arm64" : "x86_64",
    abi: platform === "macos-universal" ? "darwin-macos-11" : "linux-gnu",
    deployment_target: platform === "macos-universal" ? "11.0" : "host-glibc-exact",
    "script.preparation_recipe.sha256": recipeSha,
    ...toolchain(platform, group),
  };
  const addInput = async (target, prefix, component) => {
    await assertComponent(inputRoot, component);
    target[`${prefix}.filename`] = component.file;
    target[`${prefix}.size`] = String(component.size);
    target[`${prefix}.sha256`] = component.sha256;
  };
  if (group === "libsodium") {
    await addInput(common, "input.libsodium", COMPONENTS.sodium);
    common["source.base_tree.sha256"] = COMPONENTS.sodium.sourceTree;
    common["cache.transform.sha256"] = hashBytes(normalizeLibsodiumCachedOutput.toString());
    common["flags.c"] = platform === "macos-universal"
      ? "-O2 -fPIC -arch x86_64 -arch arm64 -mmacosx-version-min=11.0"
      : "-O2 -fPIC";
    common["flags.ld"] = platform === "macos-universal"
      ? "-arch x86_64 -arch arm64 -mmacosx-version-min=11.0"
      : "default";
    common["output.contract"] = "libsodium-static-prefix-v2-relocatable-pc";
  } else if (group === "c-toxcore") {
    await addInput(common, "input.toxcore", COMPONENTS.toxcore);
    await addInput(common, "input.cmp", COMPONENTS.cmp);
    await addInput(common, "input.libsodium", COMPONENTS.sodium);
    const sodiumContract = await contractFor({ platform, group: "libsodium", projectRoot, inputRoot, prepareScript, cacheTool });
    const platformDirectory = platform === "macos-universal" ? "macos" : "linux";
    const sodiumPrefix = path.join(projectRoot, "work", "platform", platformDirectory, "libsodium");
    const sodiumLibrary = path.join(sodiumPrefix, "lib", "libsodium.a");
    await ordinaryFile(sodiumLibrary, "Prepared libsodium static library");
    common["dependency.libsodium.fingerprint"] = computeFingerprint(sodiumContract);
    common["dependency.libsodium.library.sha256"] = await hashFile(sodiumLibrary);
    common["dependency.libsodium.headers_tree.sha256"] = await contentTreeSha256(path.join(sodiumPrefix, "include"));
    const manifestPath = path.join(projectRoot, "patches", "c-toxcore", "security-v4", "patch-manifest.json");
    const retryPath = path.join(projectRoot, "patches", "c-toxcore", "friend-request-retry-cap.patch");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.schemaVersion !== 1 || manifest.series !== "security-v4" ||
        manifest.applicationBase?.materializedBaseline?.tree?.length !== 40 ||
        manifest.candidate?.headTree?.length !== 40 || !Array.isArray(manifest.patches) || manifest.patches.length === 0) {
      throw new Error("Invalid c-toxcore patch manifest");
    }
    common["patch.retry.sha256"] = await hashFile(retryPath);
    common["patch.manifest.sha256"] = await hashFile(manifestPath);
    common["source.materialized_base_tree"] = manifest.applicationBase.materializedBaseline.tree;
    common["source.result_tree"] = manifest.candidate.headTree;
    for (const [index, patch] of manifest.patches.entries()) {
      if (patch.order !== index + 1 || patch.file !== manifest.requiredOrder?.[index] ||
          !/^[0-9A-F]{64}$/.test(patch.sha256 ?? "")) throw new Error("Invalid ordered c-toxcore patch");
      const patchPath = path.join(path.dirname(manifestPath), patch.file);
      const actual = await hashFile(patchPath);
      if (actual !== patch.sha256.toLowerCase()) throw new Error(`Patch hash mismatch: ${patch.file}`);
      common[`patch.${String(index + 1).padStart(2, "0")}.filename`] = patch.file;
      common[`patch.${String(index + 1).padStart(2, "0")}.sha256`] = actual;
    }
    common["flags.cmake"] = platform === "macos-universal"
      ? "Release;shared;toxav=off;bootstrap=off;autotest=off;arch=x86_64+arm64;deployment=11.0;install_name=@rpath"
      : "Release;shared;toxav=off;bootstrap=off;autotest=off";
    common["cache.transform.sha256"] = hashBytes(
      `${normalizeCtoxcoreCachedOutput.toString()}\n${toxcoreLibraryFiles.toString()}\n${macRpaths.toString()}\n`,
    );
    common["output.contract"] = platform === "macos-universal"
      ? "toxcore-dylib-universal-v3-no-rpath"
      : "toxcore-so-x86_64-v3-no-rpath";
  } else {
    if (platform === "macos-universal") {
      await addInput(common, "input.tor.x86_64", COMPONENTS.torMacX64);
      await addInput(common, "input.tor.arm64", COMPONENTS.torMacArm64);
      common["transform"] = "lipo-create-x86_64-arm64";
      common["output.contract"] = "tor-expert-bundle-universal-v2";
    } else {
      await addInput(common, "input.tor.x86_64", COMPONENTS.torLinux);
      common["transform"] = "verified-extract-remove-debug-chmod-runtime";
      common["output.contract"] = "tor-expert-bundle-linux-x86_64-v2";
    }
  }
  return common;
}

export function canonicalizeContract(contract) {
  const entries = Object.entries(contract).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (String(contract.schema) !== String(SCHEMA) || contract.policy !== POLICY ||
      !PLATFORMS.has(contract.platform) || !GROUPS.has(contract.group)) {
    throw new Error("Invalid prepared-cache contract identity");
  }
  for (const [key, value] of entries) {
    if (!/^[a-z0-9_.-]+$/.test(key) || typeof value !== "string" || /[\r\n\t\0]/.test(value)) {
      throw new Error(`Unsafe contract field: ${key}`);
    }
  }
  return entries.map(([key, value]) => `${key}\t${value}`).join("\n") + "\n";
}

export function computeFingerprint(contract) {
  return hashBytes(canonicalizeContract(contract));
}

function parseContract(text) {
  const contract = {};
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (!line) continue;
    const separator = line.indexOf("\t");
    if (separator <= 0) throw new Error("Invalid contract line");
    const key = line.slice(0, separator);
    if (Object.hasOwn(contract, key)) throw new Error(`Duplicate contract field: ${key}`);
    contract[key] = line.slice(separator + 1);
  }
  if (canonicalizeContract(contract) !== text.replace(/\r\n/g, "\n")) {
    throw new Error("Contract is not canonical");
  }
  return contract;
}

async function walkFiles(root) {
  await ordinaryDirectory(root, "Prepared output root");
  const outputs = [];
  const visit = async (directory, relativeBase = "") => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const child of children) {
      const relative = relativeBase ? `${relativeBase}/${child.name}` : child.name;
      const absolute = path.join(directory, child.name);
      if (child.isSymbolicLink() || (!child.isFile() && !child.isDirectory())) {
        throw new Error(`Prepared output contains unsafe entry: ${relative}`);
      }
      if (child.isDirectory()) await visit(absolute, relative);
      else {
        const item = await stat(absolute);
        outputs.push({
          path: relative,
          size: item.size,
          sha256: await hashFile(absolute),
          mode: (item.mode & 0o111) ? 0o755 : 0o644,
        });
      }
    }
  };
  await visit(root);
  if (outputs.length === 0) throw new Error("Prepared output is empty");
  return outputs;
}

function outputManifestBytes(outputs) {
  return `${JSON.stringify(outputs)}\n`;
}

function entryLocation(cacheRoot, contract, fingerprint) {
  if (!SAFE_SEGMENT.test(contract.platform) || !SAFE_SEGMENT.test(contract.group) || !SHA256.test(fingerprint)) {
    throw new Error("Unsafe prepared-cache location identity");
  }
  return path.join(cacheRoot, `schema-${SCHEMA}`, contract.platform, contract.group, fingerprint);
}

async function assertNotRevoked(cacheRoot, fingerprint, entry) {
  const candidates = [
    path.join(cacheRoot, `schema-${SCHEMA}`, "revoked", fingerprint),
    path.join(cacheRoot, `schema-${SCHEMA}`, "revoked", `${fingerprint}.json`),
    path.join(entry, "REVOKED"),
  ];
  for (const candidate of candidates) {
    if (await lstat(candidate).catch(() => null)) throw new Error(`Prepared-cache fingerprint is revoked: ${fingerprint}`);
  }
}

function requiredOutputPaths(contract) {
  if (contract.group === "libsodium") return ["include/sodium.h", "lib/libsodium.a", "lib/pkgconfig/libsodium.pc"];
  if (contract.group === "c-toxcore") return [contract.platform === "macos-universal" ? "lib/libtoxcore.dylib" : "lib/libtoxcore.so"];
  return contract.platform === "macos-universal"
    ? ["tor/tor", "tor/libevent-2.1.7.dylib", "tor/pluggable_transports/lyrebird", "tor/pluggable_transports/conjure-client"]
    : ["tor/tor", "tor/pluggable_transports/lyrebird", "tor/pluggable_transports/conjure-client"];
}

async function validateOutputShape(contract, root) {
  for (const relative of requiredOutputPaths(contract)) await ordinaryFile(path.join(root, ...relative.split("/")), `Required ${contract.group} output`);
  if (contract.platform === "macos-universal") {
    const binaries = contract.group === "libsodium" ? ["lib/libsodium.a"]
      : contract.group === "c-toxcore" ? ["lib/libtoxcore.dylib"]
      : requiredOutputPaths(contract);
    for (const relative of binaries) {
      const architectures = runExact("lipo", ["-archs", path.join(root, ...relative.split("/"))]);
      if (!/\bx86_64\b/.test(architectures) || !/\barm64\b/.test(architectures)) {
        throw new Error(`Prepared macOS output is not universal: ${relative} (${architectures})`);
      }
    }
  }
  if (contract.group === "c-toxcore") {
    const relative = contract.platform === "macos-universal" ? "lib/libtoxcore.dylib" : "lib/libtoxcore.so";
    const library = path.join(root, ...relative.split("/"));
    if (contract.platform === "macos-universal") {
      const installName = runExact("otool", ["-D", library]);
      if (!/@rpath\/libtoxcore(?:\.[0-9]+)*\.dylib/.test(installName)) throw new Error(`Unsafe c-toxcore install name: ${installName}`);
      const dependencies = runExact("otool", ["-L", library]);
      // otool prefixes its output with the inspected file's own absolute path;
      // only the following lines are load dependencies.
      if (/\/(?:Users|home)\//.test(parseOtoolLoadDependencies(dependencies))) {
        throw new Error("c-toxcore has a build-directory load dependency");
      }
      const rpaths = macRpaths(library);
      if (rpaths.length !== 0) throw new Error(`c-toxcore still has LC_RPATH entries: ${rpaths.join(", ")}`);
      const symbols = runExact("nm", ["-gU", library]);
      if (!/\b_tox_new\b/.test(symbols) || !/\b_tox_iterate\b/.test(symbols)) throw new Error("c-toxcore exports are incomplete");
    } else {
      const header = runExact("readelf", ["-h", library]);
      if (!/Machine:\s+(?:Advanced Micro Devices X86-64|AMD x86-64)/i.test(header)) throw new Error("c-toxcore ELF architecture is not x86_64");
      const dynamic = runExact("readelf", ["-d", library]);
      if (!/\(SONAME\).*\[libtoxcore\.so(?:\.[0-9]+)*\]/.test(dynamic) ||
          /\/(?:home|Users)\//.test(dynamic) || /\((?:RPATH|RUNPATH)\)/.test(dynamic)) {
        throw new Error("c-toxcore ELF SONAME/load contract is invalid");
      }
      const symbols = runExact("nm", ["-D", "--defined-only", library]);
      if (!/\btox_new\b/.test(symbols) || !/\btox_iterate\b/.test(symbols)) throw new Error("c-toxcore exports are incomplete");
    }
    for (const candidate of await toxcoreLibraryFiles(contract, root)) {
      if (contract.platform === "macos-universal") {
        const dependencies = parseOtoolLoadDependencies(runExact("otool", ["-L", candidate]));
        if (macRpaths(candidate).length !== 0 || /\/(?:Users|home)\//.test(dependencies)) {
          throw new Error(`Staged c-toxcore dylib retains a build path: ${path.basename(candidate)}`);
        }
      } else {
        const dynamic = runExact("readelf", ["-d", candidate]);
        if (/\/(?:home|Users)\//.test(dynamic) || /\((?:RPATH|RUNPATH)\)/.test(dynamic)) {
          throw new Error(`Staged c-toxcore ELF retains a build path: ${path.basename(candidate)}`);
        }
      }
    }
    const probeDirectory = await mkdtemp(path.join(os.tmpdir(), "kaigen-tox-load-"));
    try {
      const source = path.join(probeDirectory, "probe.c");
      const executable = path.join(probeDirectory, "probe");
      await writeFile(source, "#include <dlfcn.h>\n#include <stdio.h>\nint main(int argc,char **argv){if(argc!=2)return 2;void *h=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!h){fprintf(stderr,\"%s\\n\",dlerror());return 3;}if(!dlsym(h,\"tox_new\")||!dlsym(h,\"tox_iterate\"))return 4;dlclose(h);return 0;}\n");
      const compiler = contract.platform === "macos-universal" ? "clang" : "cc";
      const linkFlags = contract.platform === "macos-universal" ? [] : ["-ldl"];
      runExact(compiler, [source, "-o", executable, ...linkFlags]);
      runExact(executable, [library]);
    } finally {
      await rm(probeDirectory, { recursive: true, force: true });
    }
  }
}

async function validateEntry(cacheRoot, contract, contractText, fingerprint, validateOutputs = validateOutputShape) {
  const entry = entryLocation(cacheRoot, contract, fingerprint);
  await assertNotRevoked(cacheRoot, fingerprint, entry);
  await ordinaryDirectory(entry, "Prepared-cache entry");
  const entryMode = (await stat(entry)).mode & 0o777;
  if (process.platform !== "win32" && (entryMode & 0o222) !== 0) {
    throw new Error(`Prepared-cache entry is not immutable: ${fingerprint}`);
  }
  const names = (await readdir(entry)).sort();
  if (names.join("\n") !== "contract.tsv\nmanifest.json\noutputs") throw new Error(`Unexpected files in cache entry ${fingerprint}`);
  const storedContract = await readFile(path.join(entry, "contract.tsv"), "utf8");
  if (storedContract !== contractText) throw new Error(`Prepared-cache contract mismatch: ${fingerprint}`);
  const manifest = JSON.parse(await readFile(path.join(entry, "manifest.json"), "utf8"));
  const outputsRoot = path.join(entry, "outputs");
  const outputs = await walkFiles(outputsRoot);
  const outputHash = hashBytes(outputManifestBytes(outputs));
  if (manifest.schemaVersion !== SCHEMA || manifest.policy !== POLICY || manifest.fingerprint !== fingerprint ||
      manifest.platform !== contract.platform || manifest.group !== contract.group ||
      manifest.contractSha256 !== fingerprint || manifest.outputManifestSha256 !== outputHash ||
      JSON.stringify(manifest.outputs) !== JSON.stringify(outputs)) {
    throw new Error(`Corrupt prepared-cache manifest or output: ${fingerprint}`);
  }
  await validateOutputs(contract, outputsRoot);
  return { entry, outputsRoot, outputs, outputHash, manifest };
}

async function makeWritable(root) {
  const visit = async (target) => {
    const item = await lstat(target);
    if (item.isDirectory()) {
      await chmod(target, 0o755);
      for (const name of await readdir(target)) await visit(path.join(target, name));
    } else if (item.isFile()) await chmod(target, item.mode | 0o200);
  };
  await visit(root);
}

async function makeImmutable(root, keepRootWritable = false) {
  const visit = async (target, isRoot = false) => {
    const item = await lstat(target);
    if (item.isDirectory()) {
      for (const name of await readdir(target)) await visit(path.join(target, name), false);
      await chmod(target, isRoot && keepRootWritable ? 0o755 : 0o555);
    } else if (item.isFile()) await chmod(target, (item.mode & 0o111) ? 0o555 : 0o444);
  };
  await visit(root, true);
}

async function normalizeLibsodiumCachedOutput(root) {
  const pc = path.join(root, "lib", "pkgconfig", "libsodium.pc");
  let text = await readFile(pc, "utf8");
  if (!/^prefix=.*$/m.test(text)) throw new Error("libsodium.pc has no prefix field");
  text = text.replace(/^prefix=.*$/m, "prefix=${pcfiledir}/../..");
  await writeFile(pc, text, "utf8");
}

function macRpaths(library) {
  const lines = runExact("otool", ["-l", library]).split("\n");
  const result = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== "cmd LC_RPATH") continue;
    const pathLine = lines.slice(index + 1, index + 5).find((line) => /^\s*path\s+.+\s+\(offset\s+\d+\)\s*$/.test(line));
    const match = /^\s*path\s+(.+)\s+\(offset\s+\d+\)\s*$/.exec(pathLine ?? "");
    if (!match) throw new Error(`Cannot parse LC_RPATH in ${library}`);
    result.push(match[1]);
  }
  return [...new Set(result)];
}

export function parseOtoolLoadDependencies(output) {
  const lines = output.replace(/\r\n/g, "\n").split("\n").filter((line) => line.trim());
  if (!lines[0]?.endsWith(":") || /^\s/.test(lines[0])) {
    throw new Error("Cannot parse otool -L output header");
  }
  const dependencies = [];
  for (const line of lines.slice(1)) {
    // Universal Mach-O files are reported as one non-indented header per
    // architecture. These headers identify the inspected file, not a loaded
    // dependency, and must therefore be excluded from portability checks.
    if (!/^\s/.test(line) && line.endsWith(":")) continue;
    if (!/^\s+\S+\s+\(compatibility version /.test(line)) {
      throw new Error(`Cannot parse otool -L dependency line: ${line}`);
    }
    dependencies.push(line);
  }
  return dependencies.join("\n");
}

async function toxcoreLibraryFiles(contract, root) {
  const libraryRoot = path.join(root, "lib");
  const pattern = contract.platform === "macos-universal"
    ? /^libtoxcore(?:\.[0-9]+)*\.dylib$/
    : /^libtoxcore\.so(?:\.[0-9]+)*$/;
  const names = (await readdir(libraryRoot)).filter((name) => pattern.test(name)).sort();
  if (names.length === 0) throw new Error("Prepared c-toxcore output has no shared libraries");
  const result = [];
  for (const name of names) {
    const filename = path.join(libraryRoot, name);
    await ordinaryFile(filename, "Prepared c-toxcore shared library");
    result.push(filename);
  }
  return result;
}

async function normalizeCtoxcoreCachedOutput(contract, root) {
  const libraries = await toxcoreLibraryFiles(contract, root);
  if (contract.platform === "macos-universal") {
    for (const library of libraries) {
      for (const rpath of macRpaths(library)) runExact("install_name_tool", ["-delete_rpath", rpath, library]);
    }
  } else {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "kaigen-rpath-remove-"));
    try {
      const script = path.join(temporary, "remove-rpath.cmake");
      for (const library of libraries) {
        await writeFile(script, `file(RPATH_REMOVE FILE [==[${library}]==])\n`, "utf8");
        runExact("cmake", ["-P", script]);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

async function normalizeCachedOutput(contract, root) {
  if (contract.group === "libsodium") await normalizeLibsodiumCachedOutput(root);
  if (contract.group === "c-toxcore") await normalizeCtoxcoreCachedOutput(contract, root);
}

export async function contentTreeSha256(root) {
  const outputs = await walkFiles(root);
  const filtered = outputs.filter((entry) => entry.path !== ".git" && !entry.path.startsWith(".git/"));
  return hashBytes(filtered.map((entry) => `F\t${entry.sha256}\t${entry.path}`).join("\n") + "\n");
}

export async function materializedGitTree(root) {
  await ordinaryDirectory(root, "Materialized c-toxcore source");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "kaigen-tox-tree-"));
  const copiedRoot = path.join(temporary, "source");
  try {
    // fs.cp(source, an already-existing directory) has platform-dependent
    // nesting semantics. Always copy to a new child and hash that exact root.
    await cp(root, copiedRoot, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      filter: (source) => path.basename(source) !== ".git",
    });
    runExact("git", ["-C", copiedRoot, "init", "-q"]);
    runExact("git", ["-C", copiedRoot, "add", "--all"]);
    const staged = runExact("git", ["-C", copiedRoot, "ls-files", "--stage", "-z"]);
    for (const entry of staged.split("\0")) {
      if (!entry) continue;
      const match = /^(\d+) ([a-f0-9]{40,64}) (\d+)\t([\s\S]+)$/.exec(entry);
      if (!match) throw new Error("Unexpected git index entry while hashing c-toxcore");
      const [, mode, object, stage, filename] = match;
      if (stage !== "0") throw new Error("Unmerged c-toxcore source cannot be cached");
      if (mode === "100755" || mode === "120000") {
        runExact("git", ["-C", copiedRoot, "update-index", "--cacheinfo", `100644,${object},${filename}`]);
      }
    }
    const tree = runExact("git", ["-C", copiedRoot, "write-tree"]);
    if (!/^[a-f0-9]{40,64}$/.test(tree)) throw new Error(`Invalid materialized c-toxcore tree: ${tree}`);
    return tree;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function bootstrapProvenance(projectRoot, group, producerScript, consumerScript, cacheTool, recipeSha256) {
  const provenance = {
    mode: "validated-existing-bootstrap",
    producerScriptSha256: await hashFile(producerScript),
    consumerScriptSha256: await hashFile(consumerScript),
    cacheToolSha256: await hashFile(cacheTool),
    recipeSha256,
  };
  if (group === "libsodium") {
    const source = path.join(projectRoot, "work", "platform-sources", "libsodium-1.0.22");
    const sourceTreeSha256 = await contentTreeSha256(source);
    if (sourceTreeSha256 !== COMPONENTS.sodium.sourceTree) throw new Error(`libsodium materialized source tree mismatch: ${sourceTreeSha256}`);
    provenance.materializedSourceTreeSha256 = sourceTreeSha256;
  }
  if (group === "c-toxcore") {
    const patchRoot = path.join(projectRoot, "patches", "c-toxcore");
    const manifestPath = path.join(patchRoot, "security-v4", "patch-manifest.json");
    const retryPath = path.join(patchRoot, "friend-request-retry-cap.patch");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const ordered = [];
    for (const [index, patch] of manifest.patches.entries()) {
      if (patch.order !== index + 1 || patch.file !== manifest.requiredOrder?.[index]) throw new Error("Invalid bootstrap patch order");
      const actual = await hashFile(path.join(path.dirname(manifestPath), patch.file));
      if (actual !== patch.sha256.toLowerCase()) throw new Error(`Bootstrap patch hash mismatch: ${patch.file}`);
      ordered.push(`${patch.order}\t${patch.file}\t${actual}\t${patch.beforeTree}\t${patch.afterTree}`);
    }
    const toxSource = path.join(projectRoot, "work", "platform-sources", `c-toxcore-${COMPONENTS.toxcore.file.slice("c-toxcore-".length, -4)}`);
    const actualTree = await materializedGitTree(toxSource);
    if (actualTree !== manifest.candidate.headTree) throw new Error(`Bootstrap c-toxcore materialized tree mismatch: ${actualTree}`);
    provenance.patchManifestSha256 = await hashFile(manifestPath);
    provenance.retryPatchSha256 = await hashFile(retryPath);
    provenance.orderedPatchSetSha256 = hashBytes(`${ordered.join("\n")}\n`);
    provenance.materializedBaseTree = manifest.applicationBase.materializedBaseline.tree;
    provenance.materializedSourceTree = actualTree;
  }
  return provenance;
}

export async function promoteEntry({ cacheRoot, contract, source, provenance = {}, validateOutputs = validateOutputShape }) {
  const contractText = canonicalizeContract(contract);
  const fingerprint = computeFingerprint(contract);
  const entry = entryLocation(cacheRoot, contract, fingerprint);
  await assertNotRevoked(cacheRoot, fingerprint, entry);
  const existing = await lstat(entry).catch(() => null);
  if (existing) {
    const validated = await validateEntry(cacheRoot, contract, contractText, fingerprint, validateOutputs);
    const comparison = path.join(path.dirname(entry), `.compare-${fingerprint}-${process.pid}-${randomBytes(6).toString("hex")}`);
    try {
      await cp(source, comparison, { recursive: true, dereference: false, errorOnExist: true });
      await makeWritable(comparison);
      await normalizeCachedOutput(contract, comparison);
      const sourceOutputs = await walkFiles(comparison);
      if (JSON.stringify(sourceOutputs) !== JSON.stringify(validated.outputs)) {
        throw new Error(`Same fingerprint produced different outputs: ${fingerprint}`);
      }
    } finally {
      await rm(comparison, { recursive: true, force: true }).catch(() => {});
    }
    return { disposition: "hit", fingerprint, outputManifestSha256: validated.outputHash };
  }
  const groupRoot = path.dirname(entry);
  await mkdir(groupRoot, { recursive: true });
  await ordinaryDirectory(groupRoot, "Prepared-cache group root");
  const stage = path.join(groupRoot, `.staging-${fingerprint}-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    await mkdir(stage);
    await cp(source, path.join(stage, "outputs"), { recursive: true, dereference: false, errorOnExist: true });
    await makeWritable(path.join(stage, "outputs"));
    await normalizeCachedOutput(contract, path.join(stage, "outputs"));
    await validateOutputs(contract, path.join(stage, "outputs"));
    const outputs = await walkFiles(path.join(stage, "outputs"));
    const outputManifestSha256 = hashBytes(outputManifestBytes(outputs));
    await writeFile(path.join(stage, "contract.tsv"), contractText, { encoding: "utf8", flag: "wx" });
    await writeFile(path.join(stage, "manifest.json"), `${JSON.stringify({
      schemaVersion: SCHEMA,
      policy: POLICY,
      fingerprint,
      platform: contract.platform,
      group: contract.group,
      contractSha256: fingerprint,
      outputManifestSha256,
      outputs,
      provenance,
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    // macOS refuses renaming a directory after its own write bit is removed.
    // Freeze every child first, publish atomically, then freeze the entry root.
    await makeImmutable(stage, true);
    try {
      await rename(stage, entry);
      try {
        await chmod(entry, 0o555);
      } catch (error) {
        await makeWritable(entry).catch(() => {});
        await rm(entry, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
      await makeWritable(stage);
      await rm(stage, { recursive: true, force: true });
      const validated = await validateEntry(cacheRoot, contract, contractText, fingerprint, validateOutputs);
      if (JSON.stringify(outputs) !== JSON.stringify(validated.outputs)) throw new Error(`Concurrent cache output mismatch: ${fingerprint}`);
      return { disposition: "hit", fingerprint, outputManifestSha256: validated.outputHash };
    }
    return { disposition: "built", fingerprint, outputManifestSha256 };
  } catch (error) {
    if (await lstat(stage).catch(() => null)) {
      await makeWritable(stage).catch(() => {});
      await rm(stage, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function restoreEntry({ cacheRoot, contract, destination, validateOutputs = validateOutputShape }) {
  const contractText = canonicalizeContract(contract);
  const fingerprint = computeFingerprint(contract);
  const entry = entryLocation(cacheRoot, contract, fingerprint);
  if (!(await lstat(entry).catch(() => null))) throw new CacheMissError(`Prepared-cache miss: ${fingerprint}`);
  const validated = await validateEntry(cacheRoot, contract, contractText, fingerprint, validateOutputs);
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  const stage = path.join(parent, `.prepared-restore-${path.basename(destination)}-${process.pid}-${randomBytes(6).toString("hex")}`);
  const backup = `${stage}.old`;
  let movedOld = false;
  try {
    await cp(validated.outputsRoot, stage, { recursive: true, dereference: false, errorOnExist: true });
    await makeWritable(stage);
    const copied = await walkFiles(stage);
    if (JSON.stringify(copied) !== JSON.stringify(validated.outputs)) throw new Error(`Prepared-cache copy verification failed: ${fingerprint}`);
    if (await lstat(destination).catch(() => null)) {
      await rename(destination, backup);
      movedOld = true;
    }
    await rename(stage, destination);
    if (movedOld) await rm(backup, { recursive: true, force: true });
    return { disposition: "hit", fingerprint, outputManifestSha256: validated.outputHash };
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    if (movedOld && !(await lstat(destination).catch(() => null))) await rename(backup, destination).catch(() => {});
    throw error;
  }
}

export async function importEntry({ sourceCacheRoot, cacheRoot, contract, validateOutputs = validateOutputShape }) {
  const contractText = canonicalizeContract(contract);
  const fingerprint = computeFingerprint(contract);
  const source = await validateEntry(sourceCacheRoot, contract, contractText, fingerprint, validateOutputs);
  const result = await promoteEntry({
    cacheRoot,
    contract,
    source: source.outputsRoot,
    validateOutputs,
    provenance: {
      mode: "verified-entry-import",
      sourceFingerprint: fingerprint,
      sourceOutputManifestSha256: source.outputHash,
    },
  });
  const imported = await validateEntry(cacheRoot, contract, contractText, fingerprint, validateOutputs);
  if (imported.outputHash !== source.outputHash || JSON.stringify(imported.outputs) !== JSON.stringify(source.outputs)) {
    throw new Error(`Imported prepared-cache output differs from source: ${fingerprint}`);
  }
  return {
    disposition: "hit",
    physicalDisposition: result.disposition === "built" ? "imported" : "already-present",
    fingerprint,
    outputManifestSha256: imported.outputHash,
  };
}

async function readContractFile(filename) {
  return parseContract(await readFile(filename, "utf8"));
}

async function writeContractFile(filename, contract) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, canonicalizeContract(contract), { encoding: "utf8", flag: "w" });
}

async function cli(argv) {
  const { command, values, required } = parseArgs(argv);
  if (command === "contract") {
    const contract = await contractFor({
      platform: required("platform"), group: required("group"),
      projectRoot: path.resolve(required("project-root")), inputRoot: path.resolve(required("input-root")),
      prepareScript: path.resolve(required("prepare-script")), cacheTool: path.resolve(required("cache-tool")),
    });
    await writeContractFile(path.resolve(required("output")), contract);
    console.log(JSON.stringify({ fingerprint: computeFingerprint(contract), platform: contract.platform, group: contract.group }));
    return;
  }
  if (command === "restore" || command === "promote") {
    const contract = await readContractFile(path.resolve(required("contract")));
    const args = { cacheRoot: path.resolve(required("cache-root")), contract };
    const provenance = { mode: values.get("mode") ?? "compiled-miss" };
    if (values.get("producer-script")) provenance.producerScriptSha256 = await hashFile(path.resolve(values.get("producer-script")));
    if (values.get("cache-tool")) provenance.cacheToolSha256 = await hashFile(path.resolve(values.get("cache-tool")));
    const result = command === "restore"
      ? await restoreEntry({ ...args, destination: path.resolve(required("destination")) })
      : await promoteEntry({ ...args, source: path.resolve(required("source")), provenance });
    console.log(JSON.stringify({ ...result, platform: contract.platform, group: contract.group }));
    return;
  }
  if (command === "import") {
    const contract = await readContractFile(path.resolve(required("contract")));
    const expectedFingerprint = required("expected-fingerprint");
    const expectedPlatform = required("expected-platform");
    const expectedGroup = required("expected-group");
    const fingerprint = computeFingerprint(contract);
    if (expectedFingerprint !== fingerprint || expectedPlatform !== contract.platform || expectedGroup !== contract.group) {
      throw new Error("Imported prepared-cache identity does not match the consumer contract");
    }
    const result = await importEntry({
      sourceCacheRoot: path.resolve(required("source-cache-root")),
      cacheRoot: path.resolve(required("cache-root")),
      contract,
    });
    console.log(JSON.stringify({ ...result, platform: contract.platform, group: contract.group }));
    return;
  }
  if (command === "bootstrap") {
    const platform = required("platform");
    if (!PLATFORMS.has(platform)) throw new Error("Unsupported bootstrap platform");
    const projectRoot = path.resolve(required("project-root"));
    const inputRoot = path.resolve(required("input-root"));
    const cacheRoot = path.resolve(required("cache-root"));
    const platformOutputRoot = path.resolve(required("platform-output-root"));
    const prepareScript = path.resolve(required("prepare-script"));
    const cacheTool = path.resolve(required("cache-tool"));
    const producerScript = path.resolve(values.get("producer-prepare-script") ?? prepareScript);
    const buildId = required("build-id");
    if (!/^[a-z0-9][a-z0-9._-]{7,127}$/.test(buildId) || !projectRoot.split(path.sep).includes(buildId)) {
      throw new Error("Bootstrap build-id does not match the immutable run path");
    }
    const buildStatusPath = path.resolve(required("build-status"));
    const buildLogPath = path.resolve(required("build-log"));
    const builtArtifactPath = path.resolve(required("built-artifact"));
    const sourceMarkerPath = path.join(projectRoot, ".kaigen-lab-source");
    await ordinaryFile(buildStatusPath, "Completed build status");
    await ordinaryFile(buildLogPath, "Completed build log");
    const artifactStat = await ordinaryFile(builtArtifactPath, "Completed build artifact");
    await ordinaryFile(sourceMarkerPath, "Immutable source marker");
    if ((await readFile(buildStatusPath, "utf8")).trim() !== "success") throw new Error("Bootstrap requires a successful completed build");
    const buildLog = await readFile(buildLogPath, "utf8");
    const requiredBuildLogMarkers = platform === "macos-universal"
      ? ["Prepared macos native dependencies in", "macOS portable archive:"]
      : ["Prepared linux native dependencies in", "Debian portable archive:"];
    if (requiredBuildLogMarkers.some((marker) => !buildLog.includes(marker))) {
      throw new Error(`Completed build log does not bind native preparation and ${platform} packaging`);
    }
    const sourceMarker = (await readFile(sourceMarkerPath, "utf8")).trim();
    if (!/^[a-f0-9]{40,64} [A-Fa-f0-9]{64}$/.test(sourceMarker)) throw new Error("Immutable source marker is invalid");
    const [sourceTree, sourceArchiveSha256] = sourceMarker.split(" ");
    const buildProvenance = {
      buildId,
      buildStatusSha256: await hashFile(buildStatusPath),
      buildLogSha256: hashBytes(buildLog),
      builtArtifactSha256: await hashFile(builtArtifactPath),
      builtArtifactSize: artifactStat.size,
      sourceMarkerSha256: await hashFile(sourceMarkerPath),
      sourceTree,
      sourceArchiveSha256: sourceArchiveSha256.toLowerCase(),
    };
    const producerText = await readFile(producerScript, "utf8");
    const consumerText = await readFile(prepareScript, "utf8");
    const sourceByGroup = {
      libsodium: path.join(platformOutputRoot, "libsodium"),
      "c-toxcore": path.join(platformOutputRoot, "toxcore"),
      "tor-universal": path.join(platformOutputRoot, "TorExpertBundle"),
    };
    const receiptEntries = [];
    const verificationBase = path.resolve(values.get("verification-root") ?? os.tmpdir());
    await mkdir(verificationBase, { recursive: true });
    for (const group of GROUPS) {
      const producerRecipe = extractRecipeDescriptor(producerText, group, platform);
      const consumerRecipe = extractRecipeDescriptor(consumerText, group, platform);
      if (producerRecipe !== consumerRecipe) throw new Error(`Bootstrap producer/consumer native recipes differ for ${group}`);
      const recipeSha256 = hashBytes(producerRecipe);
      const contract = await contractFor({ platform, group, projectRoot, inputRoot, prepareScript, cacheTool });
      const provenance = {
        ...(await bootstrapProvenance(projectRoot, group, producerScript, prepareScript, cacheTool, recipeSha256)),
        ...buildProvenance,
      };
      const result = await promoteEntry({
        cacheRoot, contract, source: sourceByGroup[group],
        provenance,
      });
      const verificationDestination = path.join(verificationBase, `.verify-${platform}-${group}-${process.pid}-${randomBytes(6).toString("hex")}`);
      const verification = await restoreEntry({ cacheRoot, contract, destination: verificationDestination });
      await rm(verificationDestination, { recursive: true, force: true });
      const receiptEntry = { ...result, platform, group, verificationDisposition: verification.disposition, provenance };
      receiptEntries.push(receiptEntry);
      console.log(JSON.stringify(receiptEntry));
    }
    if (values.get("receipt")) {
      const receipt = path.resolve(values.get("receipt"));
      const temporary = `${receipt}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
      await mkdir(path.dirname(receipt), { recursive: true });
      await writeFile(temporary, `${JSON.stringify({ schemaVersion: SCHEMA, policy: POLICY, mode: "validated-existing-bootstrap", platform, entries: receiptEntries }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      try {
        await link(temporary, receipt);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    return;
  }
  throw new Error("Usage: prepared-native-cache.mjs <contract|restore|promote|import|bootstrap> ...");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  cli(process.argv.slice(2)).catch((error) => {
    if (error instanceof CacheMissError) {
      console.error(error.message);
      process.exitCode = 10;
    } else {
      console.error(error?.stack ?? String(error));
      process.exitCode = 1;
    }
  });
}
