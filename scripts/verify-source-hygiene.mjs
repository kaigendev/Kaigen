import { lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LEGACY_C_TOXCORE_SERIES = [
  "patches/c-toxcore/security",
  "patches/c-toxcore/security-v3",
];

async function existsIncludingSymlink(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function findLegacyCtoxcoreSeries(projectRoot) {
  const resolvedRoot = path.resolve(projectRoot);
  const matches = [];
  for (const relativePath of LEGACY_C_TOXCORE_SERIES) {
    if (await existsIncludingSymlink(path.join(resolvedRoot, ...relativePath.split("/")))) {
      matches.push(relativePath);
    }
  }
  return matches;
}

function legacyCtoxcoreSeriesError(matches) {
  return "Legacy c-toxcore patch series are present beside the canonical tracked security-v4 series: " +
    matches.join(", ") +
    ". Verify their hashes against security-v4/remediation provenance and remove only the proven legacy copies.";
}

async function assertNoLegacyCtoxcoreSeries(projectRoot) {
  const matches = await findLegacyCtoxcoreSeries(projectRoot);
  if (matches.length > 0) throw new Error(legacyCtoxcoreSeriesError(matches));
}

async function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await assertNoLegacyCtoxcoreSeries(projectRoot);
  console.log("source hygiene: canonical c-toxcore security-v4 series only");
}

const invokedUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedUrl === import.meta.url) {
  main().catch((error) => {
    console.error(`SOURCE_HYGIENE_ERROR ${error.message}`);
    process.exitCode = 1;
  });
}

export {
  LEGACY_C_TOXCORE_SERIES,
  assertNoLegacyCtoxcoreSeries,
  findLegacyCtoxcoreSeries,
  legacyCtoxcoreSeriesError,
};
