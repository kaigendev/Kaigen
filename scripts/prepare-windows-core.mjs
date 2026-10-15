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
  if (relative.endsWith('/Cargo.toml')) {
    text = text.replace(/(\[dependencies\.windows-(?:core|collections|future|numerics)\]\r?\nversion = ")[^"]+("\r?\n)/g, '$1=0.100.0$2')
      .replace('rust-version = "1.82"', 'rust-version = "1.95"');
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
  return text;
}

for (const spec of [...pins.packages, ...pins.provenanceInputs]) {
  if (!/^[a-z0-9-]+$/.test(spec.name) || !/^\d+\.\d+\.\d+$/.test(spec.version) || spec.filename !== `${spec.name}-${spec.version}.crate`) fail('Invalid crate identity');
  const bytes = regularBytes(path.join(inputRoot, spec.filename));
  if (bytes.length !== spec.bytes || sha(bytes) !== spec.sha256) fail(`Immutable input mismatch: ${spec.filename}`);
}
const missing = [];
for (const spec of pins.packages) {
  const directory = path.join(destination, `${spec.name}-${spec.version}`);
  if (fs.existsSync(directory)) verifyTree(directory, spec.treeSha256);
  else missing.push(spec);
}
fs.mkdirSync(destination, { recursive: true });
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
