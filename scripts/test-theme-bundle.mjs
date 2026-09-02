import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? "dist");
const retiredThemeId = ["github", "blue"].join("-");
const themeStorageKey = "kaigen-ui-theme";
const missingThemeProviderError = "useKaigenTheme must be used inside ThemeProvider";
const files = [];

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(?:css|html|js|mjs)$/iu.test(entry)) files.push(path);
  }
}

walk(root);
assert.ok(files.length > 0, `No emitted frontend files found in ${root}`);
let softThemePresent = false;
const themeRuntimeFiles = [];
for (const file of files) {
  const content = readFileSync(file, "utf8");
  assert.ok(!content.includes(retiredThemeId), `Retired theme ID survived in emitted bundle: ${file}`);
  if (content.includes("softlifegreen")) softThemePresent = true;
  const storageIndex = content.indexOf(themeStorageKey);
  const consumerIndex = content.indexOf(missingThemeProviderError);
  if (storageIndex >= 0 || consumerIndex >= 0) {
    assert.ok(storageIndex >= 0 && consumerIndex >= 0, `Theme provider and consumer split across emitted files: ${file}`);
    assert.equal(content.indexOf(themeStorageKey, storageIndex + 1), -1, `Duplicate theme provider runtime survived in ${file}`);
    assert.equal(content.indexOf(missingThemeProviderError, consumerIndex + 1), -1, `Duplicate theme consumer runtime survived in ${file}`);
    assert.ok(
      Math.abs(storageIndex - consumerIndex) <= 4096,
      `Theme provider and consumer do not share one emitted module identity: ${file}`,
    );
    themeRuntimeFiles.push(file);
  }
}
assert.ok(softThemePresent, "The emitted bundle does not contain the softlifegreen theme contract");
assert.equal(themeRuntimeFiles.length, 1, "Exactly one emitted bundle must own the shared theme runtime");
console.log(`THEME_BUNDLE_PASS root=${root} files=${files.length}`);
