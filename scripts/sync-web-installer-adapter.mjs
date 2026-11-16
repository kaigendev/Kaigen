// Regenerate the self-contained legacy adapter after changing its maintained source.
// Run from Source: node scripts/sync-web-installer-adapter.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'kaigenweb.sh');
const source = fs.readFileSync(path.join(root, 'web/installer/install-kaigen-web.sh'));
const sha = createHash('sha256').update(source).digest('hex');
const text = fs.readFileSync(target, 'utf8');
const pattern = /(?<=^write_legacy_adapter\(\) \{\n)[\s\S]*?(?=^\}\n)/m;
if (!pattern.test(text)) throw new Error('Canonical adapter boundary is missing');
if (process.argv.slice(2).some(argument => argument !== '--check')) throw new Error('Unknown argument');
if (process.argv.includes('--check')) {
  // The opener is a heredoc, so find the body between its full opener and terminator.
  const body = /<<'KAIGEN_LEGACY_ADAPTER_BASE64'[^\n]*\n([A-Za-z0-9+/=\n]+)\nKAIGEN_LEGACY_ADAPTER_BASE64/m.exec(text)?.[1];
  const decoded = gunzipSync(Buffer.from(body ?? '', 'base64'));
  if (!decoded.equals(source) || !text.includes(`'${sha}' "$destination"`)) {
    throw new Error('Embedded adapter differs from Source; run node scripts/sync-web-installer-adapter.mjs');
  }
  console.log(`WEB_LEGACY_ADAPTER_PASS sha256=${sha}`);
} else {
  const encoded = gzipSync(source, { level: 9 }).toString('base64').match(/.{1,76}/g).join('\n');
  const replacement = `  local destination=$1 temporary
  [[ ! -L $destination ]] || die 'Unsafe legacy adapter destination.'
  temporary=$(mktemp "$destination.new.XXXXXX") || die 'Cannot stage the legacy adapter.'
  if ! base64 -d <<'KAIGEN_LEGACY_ADAPTER_BASE64' | gzip -d > "$temporary"; then
${encoded}
KAIGEN_LEGACY_ADAPTER_BASE64
    rm -f -- "$temporary"; die 'Cannot decode the legacy adapter.'
  fi
  if ! printf '%s  %s\\n' '${sha}' "$temporary" | sha256sum -c - >/dev/null; then
    rm -f -- "$temporary"; die 'Legacy adapter identity mismatch.'
  fi
  chmod 700 "$temporary" || die 'Cannot secure the legacy adapter.'
  sync -f "$temporary" || die 'Cannot persist the legacy adapter.'
  mv -Tf "$temporary" "$destination" || die 'Cannot publish the legacy adapter.'
  sync -f "$(dirname -- "$destination")" || die 'Cannot persist adapter publication.'
  printf '%s  %s\\n' '${sha}' "$destination" | sha256sum -c - >/dev/null
`;
  const next = text.replace(pattern, () => replacement);
  if (next !== text) fs.writeFileSync(target, next);
  console.log(`WEB_LEGACY_ADAPTER_SYNC sha256=${sha} changed=${next !== text}`);
}
