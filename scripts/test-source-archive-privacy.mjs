import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceScript = join(projectRoot, "scripts", "build-source-archive.ps1");
const git = process.platform === "win32" ? "git.exe" : "git";
const powershell = "pwsh";
let fixtureEnvironment;

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
  return spawnSync(command, args, { cwd, env: fixtureEnvironment, encoding: "utf8", windowsHide: true });
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

async function latestDiagnostics(artifacts) {
  const folder = join(artifacts, 'source-archive-diagnostics');
  const names = await readdir(folder);
  assert.equal(names.length, 1, 'one invocation must retain one unique diagnostic receipt');
  return JSON.parse(await readFile(join(folder, names[0]), 'utf8'));
}

const fixtureBase = process.env.RUNNER_TEMP
  ? join(process.env.RUNNER_TEMP, "kaigen-script-fixtures")
  : join(projectRoot, "..", "outputs", "workflow-improvement-20261007", "fixtures");
await mkdir(fixtureBase, { recursive: true });
const temporaryRoot = await mkdtemp(join(fixtureBase, "kaigen-source-privacy-"));
let sourceIndexPath;
let sourceIndexBefore;
try {
  const emptyGitConfig = join(temporaryRoot, "gitconfig");
  await writeFile(emptyGitConfig, "", "utf8");
  fixtureEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")));
  Object.assign(fixtureEnvironment, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyGitConfig, TEMP: temporaryRoot, TMP: temporaryRoot });
  const indexPathResult = run(git, ["-c", `safe.directory=${projectRoot.replaceAll("\\", "/")}`, "rev-parse", "--path-format=absolute", "--git-path", "index"], projectRoot);
  requireSuccess(indexPathResult, "resolve source Git index");
  sourceIndexPath = indexPathResult.stdout.trim();
  sourceIndexBefore = await readFile(sourceIndexPath);
  const fixtureRoot = join(temporaryRoot, "repo");
  const fixtureScript = join(fixtureRoot, "scripts", "build-source-archive.ps1");
  await mkdir(dirname(fixtureScript), { recursive: true });
  await cp(sourceScript, fixtureScript);
  await writeFile(join(fixtureRoot, ".gitignore"), "/context.local/\n", "utf8");
  await writeFile(join(fixtureRoot, "public.txt"), "committed public data\n", "utf8");
  const openSpecFiles = ["openspec/proposal.md", "openspec/changes/private/specs/archive/spec.md"];
  for (const path of openSpecFiles) {
    await mkdir(dirname(join(fixtureRoot, path)), { recursive: true });
    await writeFile(join(fixtureRoot, path), `local-only canary: ${path}\n`, "utf8");
  }

  requireSuccess(run(git, ["init", "--quiet"], fixtureRoot), "git init");
  requireSuccess(run(git, ["config", "user.email", "privacy-test@kaigen.invalid"], fixtureRoot), "git config email");
  requireSuccess(run(git, ["config", "user.name", "Kaigen Privacy Test"], fixtureRoot), "git config name");
  requireSuccess(run(git, ["config", "commit.gpgsign", "false"], fixtureRoot), "git disable fixture signing");
  requireSuccess(run(git, ["add", ".gitignore", "public.txt", "scripts/build-source-archive.ps1", "openspec"], fixtureRoot), "git add fixture");
  requireSuccess(run(git, ["commit", "--quiet", "-m", "fixture"], fixtureRoot), "git commit fixture");
  const historicalRevision = run(git, ["rev-parse", "HEAD"], fixtureRoot).stdout.trim();
  const fixtureIndexBefore = await readFile(join(fixtureRoot, ".git", "index"));
  // Only the working-tree snapshot has today's export policy; old revisions do not inherit it.
  await cp(join(projectRoot, ".gitattributes"), join(fixtureRoot, ".gitattributes"));
  const untrackedPlan = join(fixtureRoot, 'openspec', 'changes', 'new-local-plan', 'tasks.md');
  await mkdir(dirname(untrackedPlan), { recursive: true });
  await writeFile(untrackedPlan, 'local planning canary\n');

  await writeFile(join(fixtureRoot, "public.txt"), "dirty working-tree data\n", "utf8");
  const publicNewFile = join(fixtureRoot, "src", "new-feature.ts");
  await mkdir(dirname(publicNewFile), { recursive: true });
  await writeFile(publicNewFile, "export const included = true;\n", "utf8");
  const ignoredVmFile = join(fixtureRoot, "context.local", "environments", "VM-ACCESS.md");
  await mkdir(dirname(ignoredVmFile), { recursive: true });
  await writeFile(ignoredVmFile, "private VM access canary\n", "utf8");

  const safeArtifacts = join(temporaryRoot, "safe-artifacts");
  const preflight = run(powershell, ["-NoProfile", "-NonInteractive", "-File", fixtureScript, "-ArtifactsDir", safeArtifacts, "-ValidateOnly"], fixtureRoot);
  equal(preflight.status, 0, `source input preflight must succeed: ${preflight.stderr ?? ""}`);
  ok(!(await exists(join(safeArtifacts, 'Kaigen-source-github.zip'))), "validation must not create a publishable archive");
  const validationReceipt = await latestDiagnostics(safeArtifacts);
  equal(validationReceipt.status, 'VALIDATED', 'validation must preserve its actual semantic outcome');
  ok(/^[a-f0-9]{40}$/.test(validationReceipt.tree) && /^[a-f0-9]{64}$/.test(validationReceipt.archive.sha256), 'validation must bind the intended tree and actual export hash');
  equal(validationReceipt.archive.releaseAsset, false, 'a validation export must never be labelled a release asset');
  const attributeOperations = validationReceipt.operations.filter(operation => operation.phase === 'check-attr');
  equal(attributeOperations.length, 2, 'untracked local plans need one exact attribute batch before staging and one cached batch');
  ok(attributeOperations.every(operation => operation.arguments.includes('--stdin') && operation.stdout.includes('openspec/changes/new-local-plan/tasks.md')), 'attribute batches retain exact selected path output without argv size growth');
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
  for (const path of openSpecFiles) {
    ok(!(await exists(join(safeExtract, path))), `current attributes must exclude ${path} from the actual Git archive`);
  }
  ok(fixtureIndexBefore.equals(await readFile(join(fixtureRoot, ".git", "index"))), "source packaging must preserve the real fixture Git index byte for byte");

  // Already tracked product runtime inputs must remain public without admitting arbitrary runtime data.
  const managedRuntimeInputs = [
    'runtime/dictionaries/LICENSE-en.txt', 'runtime/dictionaries/LICENSE-ru.txt',
    'runtime/dictionaries/en-US.aff', 'runtime/dictionaries/en-US.dic',
    'runtime/dictionaries/ru-RU.aff', 'runtime/dictionaries/ru-RU.dic',
    'runtime/qtox-import/README.txt', 'runtime/qtox-import/libsqlcipher-0.dll'
  ];
  for (const name of managedRuntimeInputs) {
    await mkdir(dirname(join(fixtureRoot, name)), { recursive: true });
    await writeFile(join(fixtureRoot, name), `synthetic managed product input: ${name}\n`);
  }
  requireSuccess(run(git, ['add', '--', ...managedRuntimeInputs], fixtureRoot), 'stage exact managed runtime fixture');
  requireSuccess(run(git, ['commit', '--quiet', '-m', 'managed product runtime fixture', '--', ...managedRuntimeInputs], fixtureRoot), 'commit exact managed runtime fixture');
  const managedArtifacts = join(temporaryRoot, 'managed-runtime-artifacts');
  const managedRun = run(powershell, ['-NoProfile', '-NonInteractive', '-File', fixtureScript, '-ArtifactsDir', managedArtifacts], fixtureRoot);
  equal(managedRun.status, 0, `exact managed runtime inputs must be public: ${managedRun.stderr}`);
  const managedExtract = join(temporaryRoot, 'managed-runtime-extract');
  await expandArchive(join(managedArtifacts, 'Kaigen-source-github.zip'), managedExtract);
  ok((await Promise.all(managedRuntimeInputs.map(name => exists(join(managedExtract, name))))).every(Boolean), 'actual ZIP must retain every one of the eight exact managed runtime inputs');
  const managedReceipt = await latestDiagnostics(managedArtifacts);
  ok(managedReceipt.status === 'PACKAGED' && managedReceipt.archive.forbiddenEntries.length === 0, 'managed product paths have actual public export acceptance');
  const unknownRuntimePath = 'runtime/dictionaries/private-user.dic';
  await writeFile(join(fixtureRoot, unknownRuntimePath), 'unknown runtime private canary');
  requireSuccess(run(git, ['add', '--', unknownRuntimePath], fixtureRoot), 'stage unknown runtime fixture');
  requireSuccess(run(git, ['commit', '--quiet', '-m', 'unknown runtime fixture', '--', unknownRuntimePath], fixtureRoot), 'commit unknown runtime fixture');
  const unknownArtifacts = join(temporaryRoot, 'unknown-runtime-artifacts');
  const unknownRun = run(powershell, ['-NoProfile', '-NonInteractive', '-File', fixtureScript, '-ArtifactsDir', unknownArtifacts, '-ValidateOnly'], fixtureRoot);
  ok(unknownRun.status !== 0 && unknownRun.stderr.includes('local or private path'), 'an unknown runtime file remains forbidden despite an allowed managed directory');
  const unknownReceipt = await latestDiagnostics(unknownArtifacts);
  ok(unknownReceipt.status === 'FAILED' && unknownReceipt.archive.forbiddenEntries.includes(unknownRuntimePath), 'actual export receipt identifies the unknown runtime file, not a blanket directory rejection');
  requireSuccess(run(git, ['rm', '--', unknownRuntimePath], fixtureRoot), 'remove owned unknown runtime fixture');
  requireSuccess(run(git, ['commit', '--quiet', '-m', 'remove unknown runtime fixture', '--', unknownRuntimePath], fixtureRoot), 'commit fixture canary cleanup');

  const accidentalNote = join(fixtureRoot, "accidental-service-note.txt");
  await writeFile(accidentalNote, "must stop publication\n", "utf8");
  const untrackedRejectedArtifacts = join(temporaryRoot, "untracked-rejected-artifacts");
  const earlyRejectedRun = run(powershell, ["-NoProfile", "-NonInteractive", "-File", fixtureScript, "-ArtifactsDir", untrackedRejectedArtifacts, "-ValidateOnly"], fixtureRoot);
  ok(earlyRejectedRun.status !== 0 && `${earlyRejectedRun.stderr}`.includes("outside the public source allowlist"), "the saved late source fault must be rejected by early validation");
  const untrackedRejectedRun = run(powershell, ["-NoProfile", "-NonInteractive", "-File", fixtureScript, "-ArtifactsDir", untrackedRejectedArtifacts], fixtureRoot);
  ok(untrackedRejectedRun.status !== 0, "an untracked path outside the public allowlist must stop working-tree packaging");
  ok(`${untrackedRejectedRun.stdout ?? ""}\n${untrackedRejectedRun.stderr ?? ""}`.includes("outside the public source allowlist"), "the rejection must identify the untracked-path allowlist guard");
  ok(!(await exists(join(untrackedRejectedArtifacts, "Kaigen-source-github.zip"))), "a rejected untracked path must not leave a publishable ZIP");
  await rm(accidentalNote, { force: true });

  // A clean delta is insufficient: inherited evidence must be excluded by the intended tree's attributes.
  const evidenceCanary = join(fixtureRoot, 'ci', 'releases', 'evidence', 'internal.json');
  await mkdir(dirname(evidenceCanary), { recursive: true });
  await writeFile(evidenceCanary, '{"serviceCanary":true}\n');
  requireSuccess(run(git, ['add', 'ci/releases/evidence/internal.json'], fixtureRoot), 'stage inherited evidence fixture');
  requireSuccess(run(git, ['commit', '--quiet', '-m', 'inherited service evidence', '--', 'ci/releases/evidence/internal.json'], fixtureRoot), 'commit inherited evidence fixture');
  const currentAttributes = await readFile(join(fixtureRoot, '.gitattributes'), 'utf8');
  const unprotectedAttributes = currentAttributes.split(/\r?\n/).filter(line => !line.startsWith('/ci/releases/evidence')).join('\n');
  await writeFile(join(fixtureRoot, '.gitattributes'), unprotectedAttributes);
  const leakArtifacts = join(temporaryRoot, 'parent-leak-artifacts');
  await mkdir(leakArtifacts);
  const previousZip = join(leakArtifacts, 'Kaigen-source-github.zip');
  await writeFile(previousZip, 'previous verified archive remains untouched');
  const inheritedLeak = run(powershell, ['-NoProfile', '-NonInteractive', '-File', fixtureScript, '-ArtifactsDir', leakArtifacts, '-ValidateOnly'], fixtureRoot);
  ok(inheritedLeak.status !== 0 && inheritedLeak.stderr.includes('local or private path'), 'ValidateOnly must reject an inherited service entry despite a clean public delta');
  equal(await readFile(previousZip, 'utf8'), 'previous verified archive remains untouched', 'failed validation must preserve an existing final ZIP');
  const leakReceipt = await latestDiagnostics(leakArtifacts);
  equal(leakReceipt.status, 'FAILED', 'native archive success must not become semantic privacy PASS');
  ok(leakReceipt.archive.forbiddenEntries.includes('ci/releases/evidence/internal.json') && leakReceipt.operations.at(-1).nativeExitCode === 0, 'the original native exit and actual forbidden export entry must both be retained');
  await writeFile(join(fixtureRoot, '.gitattributes'), currentAttributes);
  requireSuccess(run(git, ['add', '.gitattributes'], fixtureRoot), 'stage intended export policy');
  requireSuccess(run(git, ['commit', '--quiet', '-m', 'protected public tree', '--', '.gitattributes'], fixtureRoot), 'commit intended export policy');
  const protectedRevision = run(git, ['rev-parse', 'HEAD'], fixtureRoot).stdout.trim();
  await writeFile(join(fixtureRoot, '.gitattributes'), unprotectedAttributes);
  const protectedArtifacts = join(temporaryRoot, 'protected-revision-artifacts');
  const protectedIndexBefore = await readFile(join(fixtureRoot, '.git', 'index'));
  const protectedRun = run(powershell, ['-NoProfile', '-NonInteractive', '-File', fixtureScript, '-ArtifactsDir', protectedArtifacts, '-GitRevision', protectedRevision], fixtureRoot);
  equal(protectedRun.status, 0, `intended revision export-ignore must ignore dirty working attributes: ${protectedRun.stderr}`);
  const protectedExtract = join(temporaryRoot, 'protected-extract');
  await expandArchive(join(protectedArtifacts, 'Kaigen-source-github.zip'), protectedExtract);
  ok(!(await exists(join(protectedExtract, 'ci/releases/evidence/internal.json'))), 'protected revision excludes inherited evidence');
  equal((await readFile(join(protectedExtract, 'public.txt'), 'utf8')).trim(), 'committed public data', 'explicit revision preserves its declared bytes');
  ok(protectedIndexBefore.equals(await readFile(join(fixtureRoot, '.git', 'index'))), 'revision validation must preserve the real fixture index byte for byte');
  await writeFile(join(fixtureRoot, '.gitattributes'), currentAttributes);

  const failureArtifacts = join(temporaryRoot, 'native-failure-artifacts');
  const nativeFailure = run(powershell, ['-NoProfile', '-NonInteractive', '-File', fixtureScript, '-ArtifactsDir', failureArtifacts, '-GitRevision', 'missing-fixture-revision'], fixtureRoot);
  ok(nativeFailure.status !== 0, 'a failed native Git operation must fail the helper');
  const failureReceipt = await latestDiagnostics(failureArtifacts);
  equal(failureReceipt.status, 'FAILED', 'failure receipt must survive cleanup');
  ok(failureReceipt.operations[0].nativeExitCode !== 0 && failureReceipt.operations[0].phase === 'rev-parse', 'failure receipt retains the real numeric native exit and phase');
  ok(failureReceipt.operations[0].stderr.includes('fatal') && typeof failureReceipt.operations[0].stdout === 'string', 'failure receipt retains both original output streams');

  requireSuccess(run(git, ["add", "-f", "context.local/environments/VM-ACCESS.md"], fixtureRoot), "git force-add private canary");
  requireSuccess(run(git, ["commit", "--quiet", "-m", "private fixture", "--", "context.local/environments/VM-ACCESS.md"], fixtureRoot), "git commit private canary");
  const rejectedArtifacts = join(temporaryRoot, "rejected-artifacts");
  const rejectedRun = run(powershell, ["-NoProfile", "-NonInteractive", "-File", fixtureScript, "-ArtifactsDir", rejectedArtifacts], fixtureRoot);
  ok(rejectedRun.status !== 0, "a tracked local/private path must stop working-tree packaging");
  ok(`${rejectedRun.stdout ?? ""}\n${rejectedRun.stderr ?? ""}`.includes("local or private path"), "the rejection must identify the local/private path guard");
  ok(!(await exists(join(rejectedArtifacts, "Kaigen-source-github.zip"))), "a rejected working-tree snapshot must not leave a publishable ZIP");

  const revisionArtifacts = join(temporaryRoot, "revision-artifacts");
  const revisionRun = run(powershell, ["-NoProfile", "-NonInteractive", "-File", fixtureScript, "-ArtifactsDir", revisionArtifacts, "-GitRevision", historicalRevision], fixtureRoot);
  ok(revisionRun.status !== 0 && revisionRun.stderr.includes('local or private path'), 'historical revisions without their own export policy must fail instead of leaking OpenSpec');
  ok(!(await exists(join(revisionArtifacts, 'Kaigen-source-github.zip'))), 'a rejected revision must not leave a publishable ZIP');
} finally {
  try {
    if (sourceIndexBefore) {
      ok(sourceIndexBefore.equals(await readFile(sourceIndexPath)), "the test must preserve the SOURCE Git index byte for byte");
    }
  } finally {
    const resolvedBase = await realpath(fixtureBase);
    const resolvedTemporaryRoot = await realpath(temporaryRoot);
    const childPath = relative(resolvedBase, resolvedTemporaryRoot);
    assert.ok(childPath && !isAbsolute(childPath) && childPath !== ".." && !childPath.startsWith(`..${sep}`), "fixture cleanup must stay strictly inside its resolved base");
    assert.equal(resolve(resolvedTemporaryRoot), resolve(temporaryRoot), "fixture cleanup must not follow a redirected path");
    await rm(resolvedTemporaryRoot, { recursive: true, force: true });
  }
}

const expectedAssertions = 41;
assert.equal(assertionCount, expectedAssertions, "update the declared assertion count when source-archive privacy coverage changes");
console.log(`source archive privacy: ${assertionCount} assertions passed`);
