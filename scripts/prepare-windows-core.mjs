import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Source preparation only: no Cargo, downloads, or changes to the global registry.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pinsFile = path.join(root, 'patches/windows-core-0100/manifest.json');
const inputRoot = path.join(root, 'runtime-manifests/vendor-inputs/windows-core-0100');
const destination = path.join(root, 'local-data/windows-core-0100');
const procMacroBuildName = 'msvc-proc-macro-link.rs';
const procMacroBuild = `fn main() {
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg=/NOIMPLIB");
        println!("cargo:rustc-link-arg=/NOEXP");
    }
}
`;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
const regularBytes = file => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`Expected regular file: ${file}`);
  return fs.readFileSync(file);
};
const pinsBytes = regularBytes(pinsFile);
const pins = JSON.parse(pinsBytes);
if (pins.schemaVersion !== 1 || pins.targetCore !== '0.100.0') fail('Unsupported windows-core recipe');
if (sha(procMacroBuild) !== pins.procMacroBuildSha256) fail('Proc-macro build script differs from its pin');
if (process.argv.length !== 2) fail('Run without arguments; destination belongs to this source tree');

function inventory(directory, relative = '') {
  const rows = [];
  for (const name of fs.readdirSync(path.join(directory, relative)).sort()) {
    const file = relative ? `${relative}/${name}` : name;
    const stat = fs.lstatSync(path.join(directory, file));
    if (stat.isSymbolicLink()) fail(`Symlink denied: ${file}`);
    if (stat.isDirectory()) rows.push(...inventory(directory, file));
    else if (stat.isFile()) {
      const bytes = regularBytes(path.join(directory, file));
      rows.push({ path: file, size: bytes.length, sha256: sha(bytes) });
    } else fail(`Special file denied: ${file}`);
  }
  return rows;
}
function verifyTree(directory, expected) {
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) fail('Ordinary package directory required');
  if (sha(JSON.stringify(inventory(directory))) !== expected) fail(`Materialized tree differs from pinned inputs: ${directory}`);
}
function runTar(args) {
  const result = spawnSync('tar', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(`tar failed: ${result.error?.message || result.stderr || result.status}`);
  return result.stdout;
}
function unpack(spec, staging) {
  const archive = path.join(inputRoot, spec.filename);
  const prefix = `${spec.name}-${spec.version}/`;
  const names = runTar(['-tzf', archive]).trim().split(/\r?\n/);
  if (!names.length || names.some(name => !name.startsWith(prefix) || name.includes('\\') || name.includes(':') || name.split('/').some(part => part === '..' || part === '.'))) fail(`Unsafe crate paths: ${spec.filename}`);
  const listing = runTar(['-tvzf', archive]).trim().split(/\r?\n/);
  if (listing.some(line => !['-', 'd'].includes(line[0]))) fail(`Crate symlink or special file denied: ${spec.filename}`);
  runTar(['-xzf', archive, '-C', staging]);
}
function transform(relative, original) {
  let text = original;
  if (relative.endsWith('.rs') && /^(windows-0\.62\.2|webview2-com-sys-0\.39\.1)\//.test(relative)) {
    text = text.replace(/\bwindows_core::(TypeKind|Type|AbiType|CloneType|CopyType|InterfaceType)\b/g, 'windows_core::imp::$1')
      .replace(/\bgeneric_as_default\b/g, 'ref_as_default')
      .replace(/\bwindows_core::(Free|Owned)\b/g, 'crate::core::$1')
      .replace(/\bwindows_core::imp::Box\b/g, 'alloc::boxed::Box');
  }
  if (relative === 'windows-0.62.2/src/lib.rs') {
    text = text.replace('pub use windows_core as core;', 'extern crate alloc;\n\nmod handles;\n\n/// Core 0.100 types plus the retained handle ownership helpers.\npub mod core {\n    pub use windows_core::*;\n    pub use crate::handles::{Free, Owned};\n}');
  }
  if (relative === 'webview2-com-0.39.1/src/callback.rs') {
    text = text.replace(/\bRef\b/g, 'InRef');
  }
  if (relative === 'webview2-com-0.39.1/src/options.rs') {
    text = text.replace('IUnknown, IUnknown_Vtbl, Interface', 'IUnknown, Interface');
  }
  if (relative === 'embed-resource-3.0.12/src/windows_msvc.rs') {
    text = text.replace('cl.env().iter().find(|(k, _)| k == "INCLUDE")', 'cl.get_envs().find(|(k, _)| *k == "INCLUDE")');
  }
  if (relative === 'tauri-plugin-fs-2.7.1/src/commands.rs') {
    // The permission name is interpolated only into the debug diagnostic.
    text = text.replace('pub fn resolve_path<R: Runtime>(\n    permission: &str,', 'pub fn resolve_path<R: Runtime>(\n    _permission: &str,')
      .replace('{permission}', '{_permission}');
  }
  if (['windows-interface-0.100.0/Cargo.toml', 'windows-implement-0.100.0/Cargo.toml', 'webview2-com-macros-0.8.1/Cargo.toml'].includes(relative)) {
    // rustc loads these macro DLLs directly. Their MSVC import library and
    // export object are unused, and their creation emits localized progress.
    text = text.replace(/^build = false$/m, `build = "../${procMacroBuildName}"`);
  }
  if (relative.endsWith('/Cargo.toml')) {
    text = text.replace(/(\[dependencies\.windows-(?:core|collections|future|numerics)\]\r?\nversion = ")[^"]+("\r?\n)/g, '$1=0.100.0$2')
      .replace('rust-version = "1.82"', 'rust-version = "1.95"');
  }
  if (relative === 'windows-0.62.2/Cargo.toml') {
    text = text.replace(/\r?\n\[hints\]\r?\nmostly-unused = true\r?\n$/u, '');
  }
  if (['tao-0.37.1/Cargo.toml', 'wry-0.57.0/Cargo.toml'].includes(relative)) {
    text = text.replace(/(\[target\.[^\n]*\.dependencies\.windows-core\]\r?\nversion = ")0\.62("\r?\n)/, '$1=0.100.0$2')
      .replace(/^rust-version = "[^"]+"/m, 'rust-version = "1.95"');
  }
  if (relative === 'tao-0.37.1/src/platform_impl/windows/icon.rs') {
    text = text.replace('use windows_core::Owned;', 'use windows::core::Owned;');
  }
  if (relative === 'tauri-winrt-notification-0.8.1/src/lib.rs') {
    text = text.replace('self.on_activated = Some(TypedEventHandler::new', 'self.on_activated = Some(TypedEventHandler::<ToastNotification, IInspectable>::new')
      .replace('self.on_dismissed = Some(TypedEventHandler::new', 'self.on_dismissed = Some(TypedEventHandler::<ToastNotification, ToastDismissedEventArgs>::new')
      .replace('Self::get_activated_action(&insp)', 'Self::get_activated_action(&insp.cloned())')
      .replace('Self::get_dismissed_reason(&args)', 'Self::get_dismissed_reason(&args.cloned())')
      .replace('Some(arguments.to_string())', 'Some(arguments.display().to_string())');
  }
  if (relative === 'windows-0.62.2/src/extensions/Win32/Foundation/NTSTATUS.rs') {
    text = text.replace('windows_core::HRESULT::from_nt(self.0)', 'windows_core::HRESULT(if self.0 >= 0 { self.0 } else { self.0 | 0x1000_0000 })');
  }
  if (relative === 'windows-0.62.2/src/extensions/Win32/Foundation/WIN32_ERROR.rs') {
    text = text.replace('windows_core::HRESULT::from_win32(self.0)', 'windows_core::HRESULT(if self.0 as i32 <= 0 { self.0 as i32 } else { ((self.0 & 0x0000_FFFF) | (7 << 16) | 0x8000_0000) as i32 })');
  }
  if (['windows-0.62.2/src/extensions/Win32/System/StructuredStorage.rs', 'windows-0.62.2/src/extensions/Win32/System/Variant.rs'].includes(relative)) {
    text = text.replaceAll('BSTR::try_from(self).unwrap_or_default()', 'BSTR::try_from(self).unwrap_or_default().display()');
  }
  if (relative === 'wry-0.57.0/build.rs') {
    text = text.replace('fn main() {\n', 'fn main() {\n  println!("cargo:rustc-check-cfg=cfg(macos_12_unavailable)");\n');
  }
  if (relative === 'wry-0.57.0/src/wkwebview/mod.rs') {
    text = text.replace('runtime::{AnyObject, NSObject, ProtocolObject}', 'runtime::{AnyObject, ProtocolObject}')
      .replace('use objc2::{\n', '#[cfg(any(debug_assertions, feature = "devtools", feature = "mac-proxy"))]\nuse objc2::runtime::NSObject;\nuse objc2::{\n');
  }
  return text;
}

function replaceMaterializedFile(file, bytes) {
  const temporary = path.join(destination, `.upgrade-${crypto.randomUUID()}`);
  fs.writeFileSync(temporary, bytes, { flag: 'wx' });
  try {
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function verifyExistingTree(directory, spec, remainingUpgrades = spec.materializedUpgrades?.length ?? 1) {
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) fail('Ordinary package directory required');
  const entries = inventory(directory);
  const current = sha(JSON.stringify(entries));
  if (current === spec.treeSha256) return;
  const upgrade = spec.materializedUpgrades?.find(item => item.treeBefore === current) ?? spec.materializedUpgrade;
  const expected = upgrade?.treeAfter ?? spec.treeSha256;
  if (remainingUpgrades < 1 || !upgrade || current !== upgrade.treeBefore || upgrade.path.split('/').some(part => !part || part === '..' || part === '.') || path.isAbsolute(upgrade.path) || upgrade.path.includes('\\')) {
    fail(`Materialized tree differs from pinned inputs: ${directory}`);
  }
  const patch = pins.patches.find(item => item.path === `${path.basename(directory)}/${upgrade.path}`);
  if (!patch || !patch.before) fail(`Missing upgrade patch: ${upgrade.path}`);
  const file = path.join(directory, upgrade.path);
  const original = regularBytes(file);
  if (sha(original) !== (upgrade.fileBefore ?? patch.before)) fail(`Patch preimage differs: ${patch.path}`);
  const bytes = Buffer.from(transform(patch.path, original.toString('utf8')));
  if (sha(bytes) !== patch.after) fail(`Patch postimage differs: ${patch.path}`);
  const nextEntries = entries.map(entry => entry.path === upgrade.path
    ? { path: entry.path, size: bytes.length, sha256: patch.after }
    : entry);
  if (sha(JSON.stringify(nextEntries)) !== expected) fail(`Upgrade does not produce the pinned tree: ${directory}`);

  // Preserve the verified package until the replacement file is ready on the same volume.
  replaceMaterializedFile(file, bytes);
  verifyTree(directory, expected);
  // A pinned intermediate tree allows a retry after an interrupted multi-file upgrade.
  if (expected !== spec.treeSha256) verifyExistingTree(directory, spec, remainingUpgrades - 1);
}

for (const spec of [...pins.packages, ...pins.provenanceInputs]) {
  if (!/^[a-z0-9-]+$/.test(spec.name) || !/^\d+\.\d+\.\d+$/.test(spec.version) || spec.filename !== `${spec.name}-${spec.version}.crate`) fail('Invalid crate identity');
  const bytes = regularBytes(path.join(inputRoot, spec.filename));
  if (bytes.length !== spec.bytes || sha(bytes) !== spec.sha256) fail(`Immutable input mismatch: ${spec.filename}`);
}
fs.mkdirSync(destination, { recursive: true });
const procMacroBuildPath = path.join(destination, procMacroBuildName);
const installedProcMacroBuildSha = fs.existsSync(procMacroBuildPath) ? sha(regularBytes(procMacroBuildPath)) : null;
if (installedProcMacroBuildSha === null || installedProcMacroBuildSha === pins.procMacroBuildPreviousSha256) {
  replaceMaterializedFile(procMacroBuildPath, procMacroBuild);
}
if (sha(regularBytes(procMacroBuildPath)) !== pins.procMacroBuildSha256) fail('Materialized proc-macro build script differs from its pin');
const missing = [];
for (const spec of pins.packages) {
  const directory = path.join(destination, `${spec.name}-${spec.version}`);
  if (fs.existsSync(directory)) verifyExistingTree(directory, spec);
  else missing.push(spec);
}
if (missing.length) {
  const staging = path.join(destination, `.staging-${process.pid}-${Date.now()}`);
  fs.mkdirSync(staging);
  // Preserve failed staging for diagnosis; never overwrite an existing package.
  for (const spec of [...missing, ...pins.provenanceInputs]) unpack(spec, staging);
  for (const spec of missing) {
    const folder = `${spec.name}-${spec.version}`;
    for (const patch of pins.patches.filter(item => item.path.startsWith(`${folder}/`))) {
      if (patch.path.split('/').some(part => part === '..') || path.isAbsolute(patch.path)) fail('Unsafe patch path');
      const output = path.join(staging, patch.path);
      let bytes;
      if (patch.before === null) {
        if (fs.existsSync(output) || patch.origin !== pins.retainedRaiiSource) fail('Unexpected added file');
        bytes = regularBytes(path.join(staging, pins.retainedRaiiSource));
      } else {
        const original = regularBytes(output);
        if (sha(original) !== patch.before) fail(`Patch preimage differs: ${patch.path}`);
        bytes = Buffer.from(transform(patch.path, original.toString('utf8')));
      }
      if (sha(bytes) !== patch.after) fail(`Patch postimage differs: ${patch.path}`);
      fs.writeFileSync(output, bytes, patch.before === null ? { flag: 'wx' } : undefined);
    }
    verifyTree(path.join(staging, folder), spec.treeSha256);
  }
  for (const spec of missing) {
    const folder = `${spec.name}-${spec.version}`;
    fs.renameSync(path.join(staging, folder), path.join(destination, folder));
  }
}
const receipt = { schemaVersion: 1, manifestSha256: sha(pinsBytes), recipeSha256: sha(regularBytes(fileURLToPath(import.meta.url))), packages: pins.packages.map(({ name, version, treeSha256 }) => ({ name, version, treeSha256 })) };
const receiptFile = path.join(destination, 'materialization.json');
const receiptText = JSON.stringify(receipt, null, 2) + '\n';
if (!fs.existsSync(receiptFile) || fs.readFileSync(receiptFile, 'utf8') !== receiptText) {
  const temporary = `${receiptFile}.partial-${process.pid}`;
  fs.writeFileSync(temporary, receiptText, { flag: 'wx' });
  fs.renameSync(temporary, receiptFile);
}
console.log(`windows-core 0.100.0: ${pins.packages.length} exact source packages verified; ${missing.length} prepared offline`);
