import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runVerificationOnlyComparisonTests } from "./test-ci-incremental-verification.mjs";
import { createFullPlan, digest } from "./current-verification.mjs";

// Approval scope: commit 374f9ffa, checks 8 and 9 only. No selected route executes.
runVerificationOnlyComparisonTests();
const read = (relative) => readFile(new URL("../" + relative, import.meta.url), "utf8");
const packageJson = JSON.parse(await read("package.json"));
const catalog = JSON.parse(await read("ci/verification-current.json"));
const aliases = {
  "test:contact-groups": "test-contact-groups.mjs",
  "test:contact-group-menu-placement": "test-contact-group-menu-placement.mjs",
  "test:contact-groups-runtime": "test-contact-groups-runtime.mjs",
};
const routeIds = ["release:publication:offline-contract", "windows:native-verification-inputs:contract"];
const routes = routeIds.map((id) => {
  const matches = catalog.routes.filter((route) => route.id === id);
  assert.equal(matches.length, 1, id + " must be registered once");
  return matches[0];
});
for (const [index, file] of ["test-release-publication.mjs", "test-native-verification-inputs.mjs"].entries()) {
  assert.deepEqual(routes[index].covers, [file]);
  assert.equal(routes[index].program, "node");
  assert.deepEqual(routes[index].args, ["scripts/" + file]);
  assert.equal(routes[index].authority, "product");
  assert.equal(routes[index].proof, "contract");
  assert.deepEqual(routes[index].platforms, index ? ["windows"] : ["windows", "debian", "macos", "web"]);
}
const commands = packageJson.scripts["test:frontend"].split(/\s*&&\s*/);
const scripts = {};
for (const [alias, file] of Object.entries(aliases)) {
  assert.equal(packageJson.scripts[alias], "node scripts/" + file);
  assert.equal(commands.filter((command) => command === "npm run " + alias).length, 1, alias + " aggregate membership");
  scripts[alias] = packageJson.scripts[alias];
}
const files = await Promise.all([...Object.values(aliases), ...routes.flatMap((route) => route.covers)].map(async (file) => {
  const path = "scripts/" + file;
  return { path, sha256: digest(await read(path)) };
}));
const focusedCatalog = { ...catalog, routes, native: [], nonLeafAliases: [], controlAliases: [], coverageAliases: {}, replaceDirect: [] };
const focusedPackage = { ...packageJson, scripts };
const plan = (platform, selectedCatalog = focusedCatalog, selectedPackage = focusedPackage) => createFullPlan({
  catalog: structuredClone(selectedCatalog), packageJson: selectedPackage,
  registration: { schema: 1, nested: [], separate: [] }, files, metadata: {}, platform,
});
for (const platform of catalog.platforms) {
  const result = plan(platform);
  assert.equal(result.status, "READY");
  assert.deepEqual(result.selected.flatMap((route) => route.covers).sort(), files.map((file) => file.path.slice(8)).filter((file) => platform === "windows" || file !== "test-native-verification-inputs.mjs").sort());
  assert.equal(result.selected.length, platform === "windows" ? 5 : 4);
}
for (const id of routeIds) assert.throws(() => plan("windows", { ...focusedCatalog, routes: routes.filter((route) => route.id !== id) }), /unregistered executable test/);
for (const alias of Object.keys(aliases)) {
  const reduced = { ...scripts }; delete reduced[alias];
  assert.throws(() => plan("windows", focusedCatalog, { ...focusedPackage, scripts: reduced }), /unregistered executable test/);
}
const ui = JSON.parse(await read("src/App.ui-ids.json"));
for (const [key, selector] of [
  ["main_contacts_family_group_header", ".contact-group-header"],
  ["main_contacts_family_group_option", '.contact-group-submenu button[role="menuitemradio"]'],
]) {
  const matches = ui.families.filter((family) => family.key === key);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].containerSelector, selector);
  assert.equal(matches[0].targetSelector, ":scope");
  assert.equal(matches[0].entityKeyAttribute, "data-kaigen-ui-entity-key");
  assert.match(ui.ids[key], /^kaigen\.main\.contacts\.family\./);
}
const app = await read("src/App.tsx");
assert.match(app.slice(app.indexOf("  useLayoutEffect(() => {", app.indexOf("}, [contactContext, generalContext, groupContext]")), app.indexOf("}, [activeChat, addContactOpen, incomingRequestsOpen, screen]);") + 65), /useLayoutEffect\(\(\) => \{\s*setContactContext\(null\);\s*setGeneralContext\(null\);\s*setGroupContext\(null\);\s*setGroupSubmenu\(null\);\s*\}, \[activeChat, addContactOpen, incomingRequestsOpen, screen\]\);/);
console.log("CONTACT_CHANGE_CONTRACTS_PASS comparison-export + five changed registrations + two group families + navigation dismissal; no route execution");
