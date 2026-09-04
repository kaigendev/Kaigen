import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const catalogPaths = Object.freeze([
  "src/App.ui-ids.json",
  "src/RootApp.ui-ids.json",
  "src/Settings.ui-ids.json",
  "src/web/WebRoot.ui-ids.json",
]);
const uiIdPattern = /^kaigen\.[a-z0-9.-]+$/u;
const familyIdPattern = /^kaigen\.[a-z0-9.-]+\.family\.[a-z0-9.-]+$/u;
const entityKeyPattern = /^e-[a-f0-9]{32}$/u;

const sortedUnique = (values) => [...new Set(values)].sort();
const sameArray = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(sourceRoot, relativePath), "utf8"));
}

export async function loadUiIdentityContract() {
  const catalogs = await Promise.all(catalogPaths.map(async (relativePath) => ({
    relativePath,
    document: await readJson(relativePath),
  })));
  const history = await readJson("src/ui-id-history.json");
  if (history.schemaVersion !== 1 || typeof history.migrationId !== "string" || !Array.isArray(history.retiredIds)) {
    throw new Error("UI ID history schema is invalid.");
  }

  const retiredIds = new Set();
  for (const entry of history.retiredIds) {
    if (!entry || !uiIdPattern.test(entry.id) || typeof entry.retiredIn !== "string" || typeof entry.reason !== "string") {
      throw new Error("UI ID history contains an invalid retired entry.");
    }
    if (retiredIds.has(entry.id)) throw new Error(`UI ID history contains a duplicate retired ID: ${entry.id}`);
    retiredIds.add(entry.id);
  }

  const activeIds = new Map();
  const staticEntries = [];
  const familyEntries = [];
  for (const { relativePath, document } of catalogs) {
    if (document.schemaVersion !== 2 || typeof document.ownerComponent !== "string"
        || !document.ids || typeof document.ids !== "object"
        || !Array.isArray(document.static) || !Array.isArray(document.families)) {
      throw new Error(`UI source catalog schema is invalid: ${relativePath}`);
    }
    await access(path.join(sourceRoot, document.ownerComponent));
    const usedKeys = new Set();
    const resolveId = (definition, expectedFamily) => {
      if (!definition || typeof definition.key !== "string" || usedKeys.has(definition.key)) {
        throw new Error(`UI source catalog key is missing or duplicated: ${relativePath}`);
      }
      usedKeys.add(definition.key);
      const id = document.ids[definition.key];
      if (!uiIdPattern.test(id) || familyIdPattern.test(id) !== expectedFamily) {
        throw new Error(`UI source catalog ID has the wrong namespace: ${relativePath}/${definition.key}`);
      }
      if (retiredIds.has(id)) throw new Error(`Retired UI ID was reused: ${id}`);
      if (activeIds.has(id)) throw new Error(`Active UI ID is declared more than once: ${id}`);
      activeIds.set(id, `${relativePath}/${definition.key}`);
      return id;
    };

    for (const definition of document.static) {
      const id = resolveId(definition, false);
      const scenarios = sortedUnique(definition.scenarios ?? []);
      const selectorScenarios = sortedUnique(Object.keys(definition.selectors ?? {}));
      if (!new Set(["element", "group"]).has(definition.kind)
          || typeof definition.name !== "string" || !definition.name.trim()
          || !Number.isInteger(definition.order)
          || scenarios.length === 0 || !sameArray(scenarios, definition.scenarios)
          || !sameArray(scenarios, selectorScenarios)) {
        throw new Error(`Static UI declaration is invalid: ${id}`);
      }
      for (const selector of Object.values(definition.selectors)) {
        if (typeof selector !== "string" || !selector.trim() || /data-kaigen-(?:element|group)-id/u.test(selector)) {
          throw new Error(`Static UI selector is invalid or instrumentation-owned: ${id}`);
        }
      }
      staticEntries.push({ ...definition, id, ownerComponent: document.ownerComponent });
    }

    for (const definition of document.families) {
      const id = resolveId(definition, true);
      const scenarios = sortedUnique(definition.scenarios ?? []);
      if (!new Set(["element", "group"]).has(definition.kind)
          || typeof definition.name !== "string" || !definition.name.trim()
          || typeof definition.containerSelector !== "string" || !definition.containerSelector.trim()
          || typeof definition.targetSelector !== "string" || !definition.targetSelector.trim()
          || definition.entityKeyAttribute !== "data-kaigen-ui-entity-key"
          || !Number.isInteger(definition.order)
          || scenarios.length === 0 || !sameArray(scenarios, definition.scenarios)
          || /:nth-|data-message-key|data-kaigen-(?:element|group)-id/u.test(definition.containerSelector)) {
        throw new Error(`Dynamic UI family declaration is invalid: ${id}`);
      }
      familyEntries.push({ ...definition, id, ownerComponent: document.ownerComponent });
    }

    const declaredKeys = sortedUnique([...document.static, ...document.families].map((entry) => entry.key));
    const idKeys = sortedUnique(Object.keys(document.ids));
    if (!sameArray(declaredKeys, idKeys)) throw new Error(`UI catalog has orphan or missing ID declarations: ${relativePath}`);
  }

  const compatibility = history.compatibility;
  if (!compatibility || compatibility.schemaVersion !== 1 || compatibility.migrationId !== history.migrationId
      || !Array.isArray(compatibility.entries) || !Array.isArray(compatibility.removableOnlyAfter)) {
    throw new Error("UI ID compatibility map schema is invalid.");
  }
  const familyIds = new Set(familyEntries.map((entry) => entry.id));
  const compatibilityIds = new Set();
  for (const entry of compatibility.entries) {
    if (!retiredIds.has(entry.oldId) || compatibilityIds.has(entry.oldId) || !familyIds.has(entry.familyId)) {
      throw new Error(`UI ID compatibility entry is invalid: ${entry.oldId ?? "(missing)"}`);
    }
    compatibilityIds.add(entry.oldId);
    if (entry.resolution === "exact-composite") {
      if (!entityKeyPattern.test(entry.entityKey) || entry.compositeId !== `${entry.familyId}::${entry.entityKey}`) {
        throw new Error(`Exact UI ID compatibility entry is invalid: ${entry.oldId}`);
      }
    } else if (entry.resolution !== "requires-contact-entity-key" || typeof entry.reason !== "string") {
      throw new Error(`Unsupported UI ID compatibility resolution: ${entry.oldId}`);
    }
  }

  return {
    schemaVersion: 2,
    migrationId: history.migrationId,
    catalogPaths,
    static: staticEntries,
    families: familyEntries,
    activeIds: [...activeIds.keys()].sort(),
    retiredIds: [...retiredIds].sort(),
    compatibility,
  };
}
