import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createLogger, resolveConfig } from "vite";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const configSource = await readFile(path.join(projectRoot, "vite.config.ts"), "utf8");
assert.match(
  configSource,
  /from\s+"\.\/scripts\/web-build-id\.ts";/u,
  "the local Vite config dependency must use its explicit TypeScript extension",
);
const warnings = [];
const logger = createLogger("info");
logger.warn = (message) => warnings.push(String(message));
logger.warnOnce = logger.warn;

const config = await resolveConfig({
  root: projectRoot,
  configFile: path.join(projectRoot, "vite.config.ts"),
  customLogger: logger,
}, "build", "production");

assert.doesNotMatch(
  warnings.join("\n"),
  /unsupported by `configLoader: 'native'`|without import attributes/u,
  "the Vite configuration must remain compatible with native loading and consistent JSON import attributes",
);

const output = config.build.rolldownOptions.output;
assert.ok(output && !Array.isArray(output), "the frontend build must define one shared output configuration");
const groups = output.codeSplitting && typeof output.codeSplitting === "object"
  ? output.codeSplitting.groups
  : undefined;
assert.ok(Array.isArray(groups), "the frontend build must explicitly split its large initial chunk");

const groupByName = new Map(groups.map((group) => [group.name, group]));
const reactGroup = groupByName.get("react-runtime");
const catalogGroup = groupByName.get("ui-identity-catalogs");
assert.ok(reactGroup?.test instanceof RegExp, "React must have a stable vendor chunk rule");
assert.equal(reactGroup.test.test("C:/fixture/node_modules/react/index.js"), true);
assert.equal(reactGroup.test.test("C:/fixture/src/App.tsx"), false);
assert.equal(typeof catalogGroup?.test, "function", "UI catalogs must have a stable data chunk rule");
assert.equal(catalogGroup.test("C:/fixture/src/App.ui-ids.json?import"), true);
assert.equal(catalogGroup.test("C:/fixture/src/web/WebRoot.ui-ids.json"), true);
assert.equal(catalogGroup.test("C:/fixture/src/App.tsx"), false);

const uiCatalogConsumers = [
  "src/App.tsx",
  "src/ChatImageViewer.tsx",
  "src/RootApp.tsx",
  "src/Settings.tsx",
];
for (const relativePath of uiCatalogConsumers) {
  const source = await readFile(path.join(projectRoot, relativePath), "utf8");
  assert.match(
    source,
    /import\s+\w+\s+from\s+"[^"\r\n]+\.ui-ids\.json"\s+with\s+\{\s*type:\s*"json"\s*\};/u,
    `${relativePath} must import its UI catalog with an explicit JSON attribute`,
  );
}

console.log("VITE_WARNING_CONTRACT_PASS config_warnings=0 groups=2 json_imports=4");
