import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceScript = join(projectRoot, "scripts", "build-source-archive.ps1");
const git = process.platform === "win32" ? "git.exe" : "git";
const powershell = "pwsh";

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
  const cleanRevision = run(git, ["rev-parse", "HEAD"], fixtureRoot).stdout.trim();

  await writeFile(join(fixtureRoot, "public.txt"), "dirty working-tree data\n", "utf8");
  const publicNewFile = join(fixtureRoot, "src", "new-feature.ts");
  await mkdir(dirname(publicNewFile), { recursive: true });
  await writeFile(publicNewFile, "export const included = true;\n", "utf8");
  const ignoredVmFile = join(fixtureRoot, "context.local", "environments", "VM-ACCESS.md");
  await mkdir(dirname(ignoredVmFile), { recursive: true });
  await writeFile(ignoredVmFile, "private VM access canary\n", "utf8");

  const safeArtifacts = join(temporaryRoot, "safe-artifacts");
  const safeCommand = [
    "Remove-Item -LiteralPath 'Env:\\GIT_INDEX_FILE' -ErrorAction SilentlyContinue",
    `& ${psLiteral(fixtureScript)} -ArtifactsDir ${psLiteral(safeArtifacts)}`,
    "if (Test-Path -LiteralPath 'Env:\\GIT_INDEX_FILE') { throw 'temporary Git index leaked into the caller' }",
  ].join("; ");
  const safeRun = run(powershell, ["-NoProfile", "-NonInteractive", "-Command", safeCommand], fixtureRoot);
  equal(safeRun.status, 0, `a working-tree snapshot archive must succeed: ${safeRun.stderr ?? ""}`);
  const safeExtract = join(temporaryRoot, "safe-extract");
  await expandArchive(join(safeArtifacts, "Kaigen-source-github.zip"), safeExtract);
  equal((await readFile(join(safeExtract, "public.txt"), "utf8")).trim(), "dirty working-tree data", "the archive must bind the bytes used by the build");
  equal((await readFile(join(safeExtract, "src", "new-feature.ts"), "utf8")).trim(), "export const included = true;", "a public allowlisted untracked source file must be included");
  ok(!(await exists(join(safeExtract, "context.local", "environments", "VM-ACCESS.md"))), "ignored VM access material must stay out of the archive");
  equal(run(git, ["diff", "--cached", "--name-only"], fixtureRoot).stdout.trim(), "", "source packaging must not mutate the real Git index");

  const accidentalNote = join(fixtureRoot, "accidental-service-note.txt");
  await writeFile(accidentalNote, "must stop publication\n", "utf8");
  const untrackedRejectedArtifacts = join(temporaryRoot, "untracked-rejected-artifacts");
  const untrackedRejectedRun = run(powershell, ["-NoProfile", "-NonInteractive", "-File", fixtureScript, "-ArtifactsDir", untrackedRejectedArtifacts], fixtureRoot);
  ok(untrackedRejectedRun.status !== 0, "an untracked path outside the public allowlist must stop working-tree packaging");
  ok(`${untrackedRejectedRun.stdout ?? ""}\n${untrackedRejectedRun.stderr ?? ""}`.includes("outside the public source allowlist"), "the rejection must identify the untracked-path allowlist guard");
  ok(!(await exists(join(untrackedRejectedArtifacts, "Kaigen-source-github.zip"))), "a rejected untracked path must not leave a publishable ZIP");
  await rm(accidentalNote, { force: true });

  requireSuccess(run(git, ["add", "-f", "context.local/environments/VM-ACCESS.md"], fixtureRoot), "git force-add private canary");
  requireSuccess(run(git, ["commit", "--quiet", "-m", "private fixture", "--", "context.local/environments/VM-ACCESS.md"], fixtureRoot), "git commit private canary");
  const rejectedArtifacts = join(temporaryRoot, "rejected-artifacts");
  const rejectedRun = run(powershell, ["-NoProfile", "-NonInteractive", "-File", fixtureScript, "-ArtifactsDir", rejectedArtifacts], fixtureRoot);
  ok(rejectedRun.status !== 0, "a tracked local/private path must stop working-tree packaging");
  ok(`${rejectedRun.stdout ?? ""}\n${rejectedRun.stderr ?? ""}`.includes("local or private path"), "the rejection must identify the local/private path guard");
  ok(!(await exists(join(rejectedArtifacts, "Kaigen-source-github.zip"))), "a rejected working-tree snapshot must not leave a publishable ZIP");

  const revisionArtifacts = join(temporaryRoot, "revision-artifacts");
  const revisionRun = run(powershell, ["-NoProfile", "-NonInteractive", "-File", fixtureScript, "-ArtifactsDir", revisionArtifacts, "-GitRevision", cleanRevision], fixtureRoot);
  equal(revisionRun.status, 0, `an explicit clean revision must ignore a dirty/private working tree: ${revisionRun.stderr ?? ""}`);
  const revisionExtract = join(temporaryRoot, "revision-extract");
  await expandArchive(join(revisionArtifacts, "Kaigen-source-github.zip"), revisionExtract);
  equal((await readFile(join(revisionExtract, "public.txt"), "utf8")).trim(), "committed public data", "an explicit revision archive must contain the declared revision content");
  ok(!(await exists(join(revisionExtract, "context.local", "environments", "VM-ACCESS.md"))), "an explicit clean revision must not inherit a force-tracked private index entry");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

const expectedAssertions = 14;
assert.equal(assertionCount, expectedAssertions, "update the declared assertion count when source-archive privacy coverage changes");
console.log(`source archive privacy: ${assertionCount} assertions passed`);
