import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceScript = join(projectRoot, "scripts", "build-source-archive.ps1");
const git = process.platform === "win32" ? "git.exe" : "git";
const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";

let assertionCount = 0;
function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  assertionCount += 1;
}
function ok(value, message) {
  assert.ok(value, message);
  assertionCount += 1;
}

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
}

function requireSuccess(result, label) {
  if (result.status !== 0) {
    throw new Error(`${label} failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
}

function psLiteral(path) {
  return `'${path.replaceAll("'", "''")}'`;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function expandArchive(zipPath, destination) {
  const command = `Expand-Archive -LiteralPath ${psLiteral(zipPath)} -DestinationPath ${psLiteral(destination)} -Force`;
  requireSuccess(run(powershell, ["-NoProfile", "-NonInteractive", "-Command", command]), "Expand-Archive");
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "kaigen-source-privacy-"));
try {
  const fixtureRoot = join(temporaryRoot, "repo");
  const fixtureScript = join(fixtureRoot, "scripts", "build-source-archive.ps1");
  await mkdir(dirname(fixtureScript), { recursive: true });
  await cp(sourceScript, fixtureScript);
  await writeFile(join(fixtureRoot, ".gitignore"), "/context.local/\n", "utf8");
  await writeFile(join(fixtureRoot, "public.txt"), "committed public data\n", "utf8");

  requireSuccess(run(git, ["init", "--quiet"], fixtureRoot), "git init");
  requireSuccess(run(git, ["config", "user.email", "privacy-test@kaigen.invalid"], fixtureRoot), "git config email");
  requireSuccess(run(git, ["config", "user.name", "Kaigen Privacy Test"], fixtureRoot), "git config name");
  requireSuccess(run(git, ["config", "commit.gpgsign", "false"], fixtureRoot), "git disable fixture signing");
  requireSuccess(run(git, ["add", ".gitignore", "public.txt", "scripts/build-source-archive.ps1"], fixtureRoot), "git add fixture");
  requireSuccess(run(git, ["commit", "--quiet", "-m", "fixture"], fixtureRoot), "git commit fixture");

  await writeFile(join(fixtureRoot, "public.txt"), "dirty working-tree data\n", "utf8");
  await writeFile(join(fixtureRoot, "accidental-service-note.txt"), "must remain untracked\n", "utf8");
  const ignoredVmFile = join(fixtureRoot, "context.local", "environments", "VM-ACCESS.md");
  await mkdir(dirname(ignoredVmFile), { recursive: true });
  await writeFile(ignoredVmFile, "private VM access canary\n", "utf8");

  const safeArtifacts = join(temporaryRoot, "safe-artifacts");
  const safeRun = run(powershell, ["-NoProfile", "-NonInteractive", "-File", fixtureScript, "-ArtifactsDir", safeArtifacts], fixtureRoot);
  equal(safeRun.status, 0, `an index-tree archive must succeed: ${safeRun.stderr ?? ""}`);
  const safeExtract = join(temporaryRoot, "safe-extract");
  await expandArchive(join(safeArtifacts, "Kaigen-source-github.zip"), safeExtract);
  equal((await readFile(join(safeExtract, "public.txt"), "utf8")).trim(), "committed public data", "the archive must read content from the index tree, not the dirty working tree");
  ok(!(await exists(join(safeExtract, "accidental-service-note.txt"))), "an arbitrary untracked service note must stay out of the archive");
  ok(!(await exists(join(safeExtract, "context.local", "environments", "VM-ACCESS.md"))), "ignored VM access material must stay out of the archive");

  requireSuccess(run(git, ["add", "-f", "context.local/environments/VM-ACCESS.md"], fixtureRoot), "git force-add private canary");
  const rejectedArtifacts = join(temporaryRoot, "rejected-artifacts");
  const rejectedRun = run(powershell, ["-NoProfile", "-NonInteractive", "-File", fixtureScript, "-ArtifactsDir", rejectedArtifacts], fixtureRoot);
  ok(rejectedRun.status !== 0, "a force-tracked local/private path must stop index-tree packaging");
  ok(`${rejectedRun.stdout ?? ""}\n${rejectedRun.stderr ?? ""}`.includes("local or private path"), "the rejection must identify the local/private path guard");
  ok(!(await exists(join(rejectedArtifacts, "Kaigen-source-github.zip"))), "a rejected index tree must not leave a publishable ZIP");

  const revisionArtifacts = join(temporaryRoot, "revision-artifacts");
  const revisionRun = run(powershell, ["-NoProfile", "-NonInteractive", "-File", fixtureScript, "-ArtifactsDir", revisionArtifacts, "-GitRevision", "HEAD"], fixtureRoot);
  equal(revisionRun.status, 0, `an explicit clean revision must ignore a dirty/private index: ${revisionRun.stderr ?? ""}`);
  const revisionExtract = join(temporaryRoot, "revision-extract");
  await expandArchive(join(revisionArtifacts, "Kaigen-source-github.zip"), revisionExtract);
  equal((await readFile(join(revisionExtract, "public.txt"), "utf8")).trim(), "committed public data", "an explicit revision archive must contain the declared revision content");
  ok(!(await exists(join(revisionExtract, "context.local", "environments", "VM-ACCESS.md"))), "an explicit clean revision must not inherit a force-tracked private index entry");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

const expectedAssertions = 10;
assert.equal(assertionCount, expectedAssertions, "update the declared assertion count when source-archive privacy coverage changes");
console.log(`source archive privacy: ${assertionCount} assertions passed`);
