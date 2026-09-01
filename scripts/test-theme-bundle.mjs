import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? "dist");
const retiredThemeId = ["github", "blue"].join("-");
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
for (const file of files) {
  const content = readFileSync(file, "utf8");
  assert.ok(!content.includes(retiredThemeId), `Retired theme ID survived in emitted bundle: ${file}`);
  if (content.includes("softlifegreen")) softThemePresent = true;
}
assert.ok(softThemePresent, "The emitted bundle does not contain the softlifegreen theme contract");
console.log(`THEME_BUNDLE_PASS root=${root} files=${files.length}`);
