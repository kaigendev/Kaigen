import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadUiIdentityContract } from "./ui-identity-contract.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporaryOutput = await mkdtemp(path.join(os.tmpdir(), "kaigen-ui-identity-"));
let uiIdentityModule;
try {
  execFileSync(process.execPath, [
    path.join(root, "node_modules/typescript/bin/tsc"),
    path.join(root, "src/uiIdentity.ts"),
    "--target", "ES2022",
    "--module", "ES2022",
    "--outDir", temporaryOutput,
    "--ignoreConfig",
    "--skipLibCheck",
  ], { stdio: "inherit" });
  uiIdentityModule = await import(pathToFileURL(path.join(temporaryOutput, "uiIdentity.js")));
} finally {
  await rm(temporaryOutput, { recursive: true, force: true });
}
const { messageDayModelKey, opaqueUiEntityKey, sha256Hex, uiCompositeIdentity } = uiIdentityModule;
const contract = await loadUiIdentityContract();
let assertions = 0;
const equal = (...args) => { assertions += 1; assert.equal(...args); };
const match = (...args) => { assertions += 1; assert.match(...args); };
const ok = (...args) => { assertions += 1; assert.ok(...args); };
const notEqual = (...args) => { assertions += 1; assert.notEqual(...args); };
const throws = (...args) => { assertions += 1; assert.throws(...args); };
const doesNotMatch = (...args) => { assertions += 1; assert.doesNotMatch(...args); };

equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
match(opaqueUiEntityKey("contact", "PRIVATE-MODEL-KEY"), /^e-[a-f0-9]{32}$/u);
ok(!opaqueUiEntityKey("contact", "PRIVATE-MODEL-KEY").includes("PRIVATE-MODEL-KEY"));
notEqual(opaqueUiEntityKey("contact", "same"), opaqueUiEntityKey("profile", "same"));
equal(messageDayModelKey(new Date(2026, 8, 3, 12, 0, 0).getTime() / 1_000), "2026-09-03");
const family = contract.families[0];
const entityKey = opaqueUiEntityKey("test", "fixture");
equal(uiCompositeIdentity(family.id, entityKey), `${family.id}::${entityKey}`);
throws(() => opaqueUiEntityKey("contact", ""), /source is empty/u);
throws(() => opaqueUiEntityKey("Visible Contact Label", "fixture"), /scope is invalid/u);
throws(() => uiCompositeIdentity("kaigen.main.contacts.element.card", entityKey), /family ID is invalid/u);
throws(() => uiCompositeIdentity(family.id, "PRIVATE-MODEL-KEY"), /entity key is invalid/u);
throws(() => messageDayModelKey(Number.NaN), /timestamp is invalid/u);
equal(new Set(contract.activeIds).size, contract.activeIds.length);
equal(new Set(contract.retiredIds).size, contract.retiredIds.length);
equal(contract.activeIds.some((id) => contract.retiredIds.includes(id)), false);
ok(contract.static.length > 250, "the complete static UI surface must remain source-declared");
ok(contract.families.length >= 29, "all repeated UI roles must use declared families");

const componentSources = await Promise.all([
  "src/App.tsx",
  "src/RootApp.tsx",
  "src/Settings.tsx",
  "src/web/WebRoot.tsx",
].map(async (relativePath) => ({ relativePath, source: await readFile(path.join(root, relativePath), "utf8") })));
for (const { relativePath, source } of componentSources) {
  doesNotMatch(source, /data-kaigen-(?:ui|element|group)-id=["']kaigen\./u, `${relativePath} must consume a source declaration instead of repeating an ID literal`);
  doesNotMatch(source, /data-kaigen-(?:element|group)-id=/u, `${relativePath} must not claim prototype-owned instrumentation attributes`);
  for (const sourceMatch of source.matchAll(/data-kaigen-ui-entity-key=\{([^}]+)\}/gu)) {
    match(sourceMatch[1], /opaqueUiEntityKey\(/u, `${relativePath} must not publish a raw dynamic model identifier`);
  }
}

assert.equal(assertions, 32, "update the declared UI identity assertion count when the contract surface changes");
console.log(`UI_IDENTITY_CONTRACT_PASS assertions=${assertions} static=${contract.static.length} families=${contract.families.length} retired=${contract.retiredIds.length} compatibility=${contract.compatibility.entries.length}`);
