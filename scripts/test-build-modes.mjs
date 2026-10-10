import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const run = (program, args, options = {}) => {
  const result = spawnSync(program, args, { encoding: 'utf8', windowsHide: true, ...options });
  assert.equal(result.status, 0, `${program}: ${result.error || result.stderr || result.stdout}`);
  return result.stdout;
};

export async function runBuildModeTests() {
  assert.equal(process.platform, 'win32', 'Windows mode fixtures require the pinned PowerShell host');
  const artifacts = path.resolve(source, '../outputs/commit-bad6449-tests/build-modes');
  await mkdir(artifacts, { recursive: true });
  const fixture = await mkdtemp(path.join(artifacts, 'commands-'));
  assert.equal(path.dirname(fixture), artifacts);
  try {
    const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    const log = path.join(fixture, 'commands.jsonl');
    const spy = path.join(fixture, 'spy.cjs');
    await writeFile(spy, `require('node:fs').appendFileSync(process.env.KAIGEN_MODE_SPY_LOG, JSON.stringify(process.argv.slice(2))+'\\n');\n`);
    await mkdir(path.join(fixture, 'node_modules/.bin'), { recursive: true });
    for (const command of ['tsc', 'vite']) {
      await writeFile(path.join(fixture, `node_modules/.bin/${command}.cmd`), `@echo off\r\n"${process.execPath}" spy.cjs ${command} %*\r\n`);
    }
    const scripts = Object.fromEntries(Object.entries(pkg.scripts).map(([name, command]) => [name,
      ['build', 'build:web'].includes(name) ? command : `node spy.cjs test ${name}`]));
    await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'kaigen-mode-fixture', version: '1.0.0', scripts }));
    await writeFile(path.join(fixture, '.npmrc'), 'offline=true\naudit=false\nfund=false\n');
    const env = { ...process.env, KAIGEN_MODE_SPY_LOG: log, npm_config_userconfig: path.join(fixture, '.npmrc'), npm_config_offline: 'true' };
    for (const mode of ['build', 'build:web']) {
      await writeFile(log, '');
      run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm.cmd run ${mode}`], { cwd: fixture, env });
      const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
      assert.deepEqual(calls.map(call => call[0]), ['tsc', 'vite'], `${mode} must compile without any implicit test`);
      if (mode === 'build:web') assert(calls[1].includes('web'), 'Web build mode must be preserved');
    }

    // Execute the actual AST-selected mode branches, never a builder's top-level setup/build/install body.
    const ps = String.raw`
param([string]$Source, [string]$Fixture)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.ToString() -cne '7.6.5') { throw 'Pinned PowerShell required' }
function Ast($Name) {
  $tokens=$null; $errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $Source $Name),[ref]$tokens,[ref]$errors)
  if ($errors.Count) { throw 'Production script parse failed' }; return $ast
}
function Record($Name) { Add-Content -LiteralPath $env:KAIGEN_MODE_SPY_LOG -Value $Name; $global:LASTEXITCODE=0 }
function npm.cmd { Record ('npm '+($args -join ' ')) }
function cargo { Record ('cargo '+($args -join ' ')) }
function Calls { @(Get-Content -LiteralPath $env:KAIGEN_MODE_SPY_LOG) }
function Check($Condition,$Message) { if (-not $Condition) { throw $Message } }
$portable=Ast 'scripts/build-portable.ps1'
$branches=@($portable.FindAll({param($a) $a -is [Management.Automation.Language.IfStatementAst] -and $a.Clauses[0].Item1.Extent.Text -eq '$PipelineStage -ceq ''build-only''' -and $a.Extent.Text.Contains('regression tests not requested.')},$true))
$security=@($portable.FindAll({param($a) $a -is [Management.Automation.Language.IfStatementAst] -and $a.Clauses[0].Item1.Extent.Text -eq '$PipelineStage -cne ''build-only'''},$true))
Check ($branches.Count -eq 2 -and $security.Count -eq 1) 'Exact portable mode branches changed'
# PowerShell function spies consume the -- terminator; retain its exact production spelling separately.
Check ($security[0].Extent.Text.Contains('& npm.cmd run test:built-content-security -- dist')) 'Built security argument separator changed'
$env:KAIGEN_WINDOWS_PIPELINE_STAGE=$null
$default=[scriptblock]::Create($portable.ParamBlock.Extent.Text + "\n" + '$PipelineStage')
$UiAcceptance=$false; $incrementalVerification=$false; $rustPathRemapFlags=@()
foreach ($selection in @('default','build-only','all')) {
  Set-Content -LiteralPath $env:KAIGEN_MODE_SPY_LOG -Value ''
  $PipelineStage=if($selection -eq 'default') { & $default } else { & $default -PipelineStage $selection }
  if ($selection -eq 'default') { Check ($PipelineStage -ceq 'build-only') 'Default portable stage changed' }
  foreach($branch in @($branches)+@($security)) { & ([scriptblock]::Create('$PSScriptRoot = $Fixture' + [Environment]::NewLine + $branch.Extent.Text)) }
  $calls=@(Calls | Where-Object { $_ })
  if($selection -eq 'all') {
    $expected=@('native test-prepared-native-cache-windows.ps1','native test-toxcore-retry-cap.ps1','native test-offline-friend-request-loopback.ps1','npm run test:frontend','cargo test --locked --manifest-path src-tauri\Cargo.toml --lib','npm run test:built-content-security dist')
    Check (($calls -join [char]0x1F) -ceq ($expected -join [char]0x1F)) ('Explicit all changed exact test invocations: '+($calls -join ' | '))
  } else { Check ($calls.Count -eq 0) 'Portable build-only invoked tests' }
}
$msi=Ast 'scripts/build-windows-msi.ps1'
$launch=@($msi.FindAll({param($a) $a -is [Management.Automation.Language.IfStatementAst] -and $a.Clauses[0].Item1.Extent.Text -eq '$RunInstallerTests' -and $a.Extent.Text.Contains('test-windows-msi-launch-policy.ps1')},$true))
Check ($launch.Count -eq 1) 'Exact MSI metadata test guard changed'
$metadata=@($msi.FindAll({param($a) $a -is [Management.Automation.Language.AssignmentStatementAst] -and $a.Left.Extent.Text -eq '$launchPolicyStatus'},$true))
Check ($metadata.Count -eq 1) 'MSI launch-policy result metadata changed'
$msiDefault=[scriptblock]::Create($msi.ParamBlock.Extent.Text + "\n" + '$RunInstallerTests.IsPresent')
Check (-not (& $msiDefault -PortableRoot $Fixture)) 'MSI default requested installer tests'
$msiPath='fixture.msi'
foreach ($selection in @('default','explicit')) {
  Set-Content -LiteralPath $env:KAIGEN_MODE_SPY_LOG -Value ''
  $RunInstallerTests=$selection -ne 'default'
  & ([scriptblock]::Create('$PSScriptRoot = $Fixture' + [Environment]::NewLine + $launch[0].Extent.Text))
  foreach($assignment in $metadata) { . ([scriptblock]::Create($assignment.Extent.Text)) }
  if($selection -eq 'default') {
    Check (@(Calls | Where-Object { $_ }).Count -eq 0) 'MSI default invoked tests'
    Check ($launchPolicyStatus -ceq 'not-run') 'MSI default falsely claims verified'
  } else {
    Check (@(Calls | Where-Object { $_ }).Count -eq 1) 'Explicit MSI lost launch-policy tests'
    Check ($launchPolicyStatus -ceq 'verified') 'Explicit launch policy metadata changed'
  }
}
Write-Output 'WINDOWS_MODE_SPIES_PASS'
`;
    // Param/default snippets require actual PowerShell newline characters, not a literal backslash+n.
    const psFile = path.join(fixture, 'mode-fixture.ps1');
    await writeFile(psFile, ps.replaceAll('"\\n"', '"`n"'));
    for (const name of ['test-prepared-native-cache-windows.ps1', 'test-toxcore-retry-cap.ps1', 'test-offline-friend-request-loopback.ps1', 'test-windows-msi-launch-policy.ps1']) {
      await writeFile(path.join(fixture, name), `param([string]$MsiPath)\nAdd-Content -LiteralPath $env:KAIGEN_MODE_SPY_LOG -Value 'native ${name}'\n$global:LASTEXITCODE=0\n`);
    }
    assert(run('pwsh', ['-NoLogo', '-NoProfile', '-File', psFile, '-Source', source, '-Fixture', fixture], { cwd: fixture, env }).includes('WINDOWS_MODE_SPIES_PASS'));

    const bash = 'C:/Program Files/Git/bin/bash.exe';
    for (const filename of ['build-appimage.sh', 'build-macos.sh']) {
      const text = (await readFile(path.join(source, 'scripts', filename), 'utf8')).replaceAll('\r\n', '\n');
      const blocks = [...text.matchAll(/^if \[\[ "\$\{KAIGEN_BUILD_TEST_MODE:-none\}"[\s\S]*?^fi$/gm)].map(match => match[0]);
      assert.equal(blocks.length, filename === 'build-appimage.sh' ? 2 : 1, 'Exact Unix mode blocks changed');
      const body = `set -eu\nproject_root=fixture\ncargo() { echo "SPY cargo $*"; }\nnode() { echo "SPY node $*"; }\nbash() { echo "SPY bash $*"; }\n${blocks.join('\n')}\n`;
      for (const [mode, ci, expected] of [['', '', 0], ['none', 'true', 0], ['full', '', filename === 'build-appimage.sh' ? 3 : 1], ['full', 'true', filename === 'build-appimage.sh' ? 3 : 1]]) {
        const output = run(bash, ['-c', body], { env: { ...env, KAIGEN_BUILD_TEST_MODE: mode, GITHUB_ACTIONS: ci, KAIGEN_CI_TEST_POLICY: '', KAIGEN_CI_EVIDENCE_ROOT: 'fixture' } });
        const calls = output.split('\n').filter(line => line.startsWith('SPY '));
        assert.equal(calls.length, expected, `${filename} ${mode || 'default'} test selection`);
        if (mode === 'full') {
          const platform = filename === 'build-appimage.sh' ? 'debian' : 'macos';
          const helpers = platform === 'debian' ? ['SPY bash fixture/scripts/test-apprun-linux.sh', 'SPY bash fixture/scripts/test-appimage-tool-cache.sh'] : [];
          const test = ci ? `SPY node scripts/ci-incremental-verification.mjs run-tests --platform ${platform} --evidence-root fixture` : 'SPY cargo test --locked --manifest-path src-tauri/Cargo.toml';
          assert.deepEqual(calls, [...helpers, test], 'Explicit full changed exact test invocations');
        }
      }
    }
    console.log('Build modes: npm/portable/MSI/Unix default command spies, explicit modes and honest MSI metadata passed');
  } finally {
    assert.equal(path.dirname(fixture), artifacts);
    await rm(fixture, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runBuildModeTests();
