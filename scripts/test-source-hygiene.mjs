import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertNoLegacyCtoxcoreSeries,
  findLegacyCtoxcoreSeries,
} from "./verify-source-hygiene.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await assertNoLegacyCtoxcoreSeries(projectRoot);

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "kaigen-source-hygiene-"));
try {
  const patchRoot = path.join(fixtureRoot, "patches", "c-toxcore");
  await mkdir(path.join(patchRoot, "security-v4"), { recursive: true });
  assert.deepEqual(await findLegacyCtoxcoreSeries(fixtureRoot), []);

  await mkdir(path.join(patchRoot, "security"));
  assert.deepEqual(await findLegacyCtoxcoreSeries(fixtureRoot), ["patches/c-toxcore/security"]);
  await assert.rejects(
    assertNoLegacyCtoxcoreSeries(fixtureRoot),
    /Legacy c-toxcore patch series.*patches\/c-toxcore\/security/u,
  );

  await rm(path.join(patchRoot, "security"), { recursive: true, force: true });
  await writeFile(path.join(patchRoot, "security-v3"), "unexpected legacy file\n", "utf8");
  assert.deepEqual(await findLegacyCtoxcoreSeries(fixtureRoot), ["patches/c-toxcore/security-v3"]);
  await assert.rejects(
    assertNoLegacyCtoxcoreSeries(fixtureRoot),
    /patches\/c-toxcore\/security-v3.*security-v4/u,
  );

  await rm(path.join(patchRoot, "security-v3"), { force: true });
  await mkdir(path.join(patchRoot, "security-v2"));
  assert.deepEqual(await findLegacyCtoxcoreSeries(fixtureRoot), []);
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

console.log("source hygiene: legacy c-toxcore series are rejected without false positives");
