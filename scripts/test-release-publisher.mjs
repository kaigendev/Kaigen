import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';

// Execute workflow code, not a parallel implementation of its validation logic.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const yaml = fs.readFileSync(path.join(root, '.github/workflows/publish-release.yml'), 'utf8').replaceAll('\r\n', '\n');
function runBlock(name) {
  const marker = '      - name: ' + name + '\n';
  assert.equal(yaml.split(marker).length, 2, 'unique workflow step: ' + name);
  const step = yaml.split(marker)[1].split('\n      - ')[0];
  const lines = step.split('        run: |\n');
  assert.equal(lines.length, 2, 'literal run block required');
  return lines[1].split('\n').filter(line => line.length).map(line => {
    assert.ok(line.startsWith('          '), 'unexpected workflow indentation');
    return line.slice(10);
  }).join('\n') + '\n';
}
const producerBlock = runBlock('Bind successful producer artifacts to exact main and current attempts');
assert.ok(producerBlock.startsWith("node --input-type=module <<'JS'\n") && producerBlock.endsWith('JS\n'));
const producerJS = producerBlock.slice(producerBlock.indexOf('\n') + 1, -3);
const publishBlock = runBlock('Publish seven exact Actions-produced assets without running tests');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
assert.ok(fs.existsSync(bash), 'Git Bash (Windows) or /bin/bash is required');
const workspace = path.join(root, 'context.local/work/test-approved-workflow-commit/publisher');
fs.mkdirSync(workspace, { recursive: true });
const session = fs.mkdtempSync(path.join(workspace, 'run-'));
const sha = 'a'.repeat(40), repo = 'kaigendev/Kaigen', label = '0.3.0.1';
const containers = [
  ['windows', 101, 'Kaigen-portable-windows-x64', ['Kaigen-portable-windows-x64.zip']],
  ['installer', 101, 'Kaigen-installer-windows-x64', ['Kaigen-installer-windows-x64.msi']],
  ['source', 101, 'Kaigen-source-github', ['Kaigen-source-github.zip']],
  ['debian', 202, 'Kaigen-portable-debian-x64', ['Kaigen-portable-debian-x64.zip']],
  ['macos', 202, 'Kaigen-portable-macos-universal', ['Kaigen-portable-macos-universal.zip']],
  ['web', 202, 'Kaigen-Web-Debian13-Nginx-' + label, ['Kaigen-Web-Debian13-Nginx-' + label + '.tar.gz', 'Kaigen-Web-Installer-' + label + '.sh']],
];
const expectedAssets = containers.flatMap(([key, , , files]) => files.map(file => key === 'source' ? 'Kaigen-source-' + label + '.zip' : file)).sort();
const preload = path.join(session, 'offline.cjs');
fs.writeFileSync(preload, `
const fs = require('node:fs');
const fixture = JSON.parse(fs.readFileSync(process.env.FIXTURE, 'utf8'));
const deny = () => { throw new Error('network forbidden in publisher regression'); };
for (const name of ['http','https']) { const m = require('node:' + name); m.request = deny; m.get = deny; }
for (const name of ['net','tls']) { const m = require('node:' + name); m.connect = deny; m.createConnection = deny; }
require('node:net').Socket.prototype.connect = deny;
require('node:dgram').createSocket = deny;
global.fetch = async url => {
  const prefix = 'https://api.github.com/repos/kaigendev/Kaigen/';
  if (!url.startsWith(prefix)) deny();
  const route = url.slice(prefix.length);
  if (!Object.hasOwn(fixture.api, route)) throw new Error('unexpected mocked API route: ' + route);
  return { status: 200, json: async () => fixture.api[route] };
};
require('node:child_process').execFileSync = (command, args) => {
  if (command !== 'git' || JSON.stringify(args) !== '["rev-parse","HEAD"]') throw new Error('unexpected child command');
  return fixture.sha + '\\n';
};
require('node:module').syncBuiltinESMExports();
`);
const mock = path.join(session, 'commands.cjs');
fs.writeFileSync(mock, `
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const [command,...args] = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(process.env.FIXTURE,'utf8'));
const statePath = process.env.STATE;
const state = JSON.parse(fs.readFileSync(statePath,'utf8'));
state.calls.push([command,...args]);
function save() { fs.writeFileSync(statePath,JSON.stringify(state)); }
function output(value) { process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); }
try {
  if (command === 'mkdir') { fs.mkdirSync(args[0]); }
  else if (command === 'cp') {
    const destination = fs.existsSync(args[1]) && fs.statSync(args[1]).isDirectory() ? path.join(args[1],path.basename(args[0])) : args[1];
    fs.copyFileSync(args[0],destination);
  } else if (command === 'sha256sum') {
    for (const file of args) output(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') + '  ' + file + '\\n');
  } else if (command === 'git') { assert.deepEqual(args,['rev-parse','--verify','refs/tags/'+process.env.KAIGEN_RELEASE_TAG]);save();process.exit(1); }
  else if (command === 'gh' && args[0] === 'api') {
    assert.deepEqual(args,['api','repos/kaigendev/Kaigen/branches/main','--jq','.commit.sha']);output(fixture.sha);
  }
  else if (command === 'gh' && args[0] === 'release') {
    assert.equal(args[2],process.env.KAIGEN_RELEASE_TAG,'exact release tag required');
    if (args[1] === 'view') {
      assert.equal(args.length,5);assert.equal(args[3],'--json');assert.ok(['isDraft','isDraft,assets','assets'].includes(args[4]));
      if (!state.exists) { save(); process.exit(1); } output({isDraft:state.isDraft,assets:state.assets.map(name=>({name}))});
    }
    else if (args[1] === 'create') {
      assert.deepEqual(args,['release','create',process.env.KAIGEN_RELEASE_TAG,'--target',fixture.sha,'--title','Kaigen '+process.env.KAIGEN_RELEASE_LABEL,'--notes-file','release-notes.txt','--draft']);
      assert.equal(state.exists,false);assert.ok(fs.existsSync('release-notes.txt'));state.exists=true;state.isDraft=true;
    }
    else if (args[1] === 'upload') {
      assert.equal(state.exists,true);assert.equal(state.isDraft,true);assert.equal(args.at(-1),'--clobber');
      const files=args.slice(3,-1);assert.equal(files.length,7);assert.ok(files.every(file=>file.startsWith('release/')&&fs.statSync(file).isFile()));
      state.assets=[...new Set([...state.assets,...files.map(file=>path.basename(file))])];if(fixture.lateExtra)state.assets.push('unrelated.txt');
    }
    else if (args[1] === 'edit') {
      assert.deepEqual(args,['release','edit',process.env.KAIGEN_RELEASE_TAG,'--draft=false']);assert.equal(state.exists,true);assert.equal(state.isDraft,true);state.isDraft=false;state.published=true;
    }
    else throw Error('unexpected gh release command');
  } else throw Error('unexpected external command: '+command);
  save();
} catch(error) { save();console.error(error.message);process.exit(1); }
`);
const bin = path.join(session, 'bin');
fs.mkdirSync(bin);
for (const command of ['node', 'gh', 'git', 'cp', 'mkdir', 'sha256sum']) {
  const body = command === 'node'
    ? 'exec "$TEST_NODE_EXE" --require "$PRELOAD" "$@"'
    : 'exec "$TEST_NODE_EXE" --require "$PRELOAD" "$MOCK" ' + command + ' "$@"';
  fs.writeFileSync(path.join(bin, command), '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
}
function fixture(name, mutate = () => {}) {
  const cwd = path.join(session, name);fs.mkdirSync(cwd);
  const api = { 'branches/main': {commit:{sha}} };
  for (const [id, workflow] of [[101,'build-windows.yml'],[202,'build-unix.yml']]) {
    api['actions/runs/' + id] = { repository:{full_name:repo},head_repository:{full_name:repo},head_sha:sha,head_branch:'main',event:'push',path:'.github/workflows/'+workflow,status:'completed',conclusion:'success',run_attempt:2,run_started_at:'2026-10-08T10:00:00Z' };
    api['actions/runs/' + id + '/artifacts?per_page=100'] = { artifacts: containers.filter(c=>c[1]===id).map(c=>({name:c[2],id:containers.indexOf(c)+1,expired:false,workflow_run:{id,head_sha:sha},created_at:'2026-10-08T10:01:00Z',digest:'sha256:'+'b'.repeat(64)})) };
  }
  const data = {sha,api};mutate(data);
  fs.writeFileSync(path.join(cwd,'fixture.json'),JSON.stringify(data));
  fs.writeFileSync(path.join(cwd,'package.json'),JSON.stringify({version:'0.3.0+1'}));
  fs.writeFileSync(path.join(cwd,'state.json'),JSON.stringify({exists:false,isDraft:true,assets:[],calls:[],published:false}));
  const env = { ...process.env, FIXTURE:path.join(cwd,'fixture.json'),STATE:path.join(cwd,'state.json'),PRELOAD:preload,MOCK:mock,TEST_NODE_EXE:process.execPath.replaceAll('\\','/'),PATH:bin.replaceAll('\\','/'),EXPECTED_SHA:sha,GITHUB_SHA:sha,GITHUB_REPOSITORY:repo,WINDOWS_RUN_ID:'101',UNIX_RUN_ID:'202',GH_TOKEN:'offline-placeholder',GITHUB_OUTPUT:path.join(cwd,'outputs'),KAIGEN_RELEASE_LABEL:label,KAIGEN_RELEASE_TAG:'v'+label };
  // Do not inherit ambient runtime injection or proxy credentials into fixtures.
  delete env.NODE_OPTIONS;delete env.BASH_ENV;delete env.ENV;
  for (const key of Object.keys(env)) if (/proxy/i.test(key)) delete env[key];
  return {cwd,env,data};
}
function producers(f) {
  return spawnSync(process.execPath,['--require',preload,'--input-type=module'],{cwd:f.cwd,env:f.env,input:producerJS,encoding:'utf8',timeout:15000});
}
function payloads(f) {
  const outputs = Object.fromEntries(fs.readFileSync(f.env.GITHUB_OUTPUT,'utf8').trim().split('\n').map(line=>line.split('=')));
  assert.equal(Object.keys(outputs).length,6);
  for (const [key, , , files] of containers) {
    assert.equal(outputs[key],String(containers.findIndex(c=>c[0]===key)+1));
    const directory = path.join(f.cwd,'incoming',key);fs.mkdirSync(directory,{recursive:true});
    for (const file of files) fs.writeFileSync(path.join(directory,file),'producer payload '+file);
  }
}
function publish(f) {
  fs.writeFileSync(path.join(f.cwd,'publish.sh'),publishBlock);
  return spawnSync(bash,['--noprofile','--norc','publish.sh'],{cwd:f.cwd,env:f.env,encoding:'utf8',timeout:30000});
}
function state(f) {return JSON.parse(fs.readFileSync(f.env.STATE,'utf8'));}
function succeeded(result) {assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);}
function failed(result) {assert.equal(result.error,undefined);assert.notEqual(result.status,0,'must reject fixture');}
test('six actual producer selections become seven exact published payloads',()=>{
  const f=fixture('valid');succeeded(producers(f));payloads(f);succeeded(publish(f));
  assert.deepEqual(state(f).assets.sort(),expectedAssets);assert.equal(state(f).published,true);assert.equal(state(f).isDraft,false);
  assert.deepEqual(fs.readdirSync(path.join(f.cwd,'release')).sort(),expectedAssets);
  for(const file of expectedAssets) assert.equal(fs.readFileSync(path.join(f.cwd,'release',file),'utf8'),'producer payload '+(file.startsWith('Kaigen-source-')?'Kaigen-source-github.zip':file));
});
for (const [name,mutate] of [
  ['wrong-sha',d=>d.api['actions/runs/101'].head_sha='c'.repeat(40)],
  ['wrong-workflow',d=>d.api['actions/runs/101'].path='.github/workflows/other.yml'],
  ['invalid-attempt',d=>d.api['actions/runs/101'].run_attempt=0],
  ['prior-attempt-artifact',d=>d.api['actions/runs/101/artifacts?per_page=100'].artifacts[0].created_at='2026-10-08T09:59:00Z'],
  ['invalid-digest',d=>d.api['actions/runs/101/artifacts?per_page=100'].artifacts[0].digest='invalid'],
  ['missing-artifact',d=>d.api['actions/runs/101/artifacts?per_page=100'].artifacts.pop()],
]) test(name+' stops before publication',()=>{const f=fixture(name,mutate);failed(producers(f));assert.deepEqual(state(f).calls,[]);assert.equal(state(f).published,false);});
test('missing payload stops before release creation or upload',()=>{
  const f=fixture('missing-payload');succeeded(producers(f));payloads(f);fs.unlinkSync(path.join(f.cwd,'incoming/web',containers[5][3][1]));failed(publish(f));assert.ok(state(f).calls.every(c=>c[0]!=='gh'));assert.equal(state(f).published,false);
});
test('existing draft extra is retained without upload or publication',()=>{
  const f=fixture('existing-extra');succeeded(producers(f));payloads(f);fs.writeFileSync(f.env.STATE,JSON.stringify({exists:true,isDraft:true,assets:['unrelated.txt'],calls:[],published:false}));failed(publish(f));assert.deepEqual(state(f).assets,['unrelated.txt']);assert.ok(!state(f).calls.some(c=>c[0]==='gh'&&['upload','edit'].includes(c[2])));assert.equal(state(f).isDraft,true);
});
test('late extra asset leaves uploaded release draft',()=>{
  const f=fixture('late-extra',d=>d.lateExtra=true);succeeded(producers(f));payloads(f);failed(publish(f));assert.ok(state(f).calls.some(c=>c[0]==='gh'&&c[2]==='upload'));assert.ok(!state(f).calls.some(c=>c[0]==='gh'&&c[2]==='edit'));assert.equal(state(f).isDraft,true);assert.equal(state(f).published,false);
});
test('workflow download wiring retains exact six IDs, run bindings and digest rejection',()=>{
  const downloads=[...yaml.matchAll(/      - uses: actions\/download-artifact@[^\n]+\n        with:\n([\s\S]*?)(?=      - |$)/g)];assert.equal(downloads.length,6);
  for(const [key,id]of containers){const body=downloads.find(m=>m[1].includes('path: incoming/'+key+'\n'))?.[1];assert.ok(body,key);assert.ok(body.includes('artifact-ids: ${{ steps.producers.outputs.'+key+' }}'));assert.ok(body.includes('run-id: ${{ inputs.'+(id===101?'windows':'unix')+'_run_id }}'));assert.ok(body.includes('digest-mismatch: error'));}
});
console.log('Publisher fixture root: '+session);
console.log('Workflow SHA256: '+createHash('sha256').update(fs.readFileSync(path.join(root,'.github/workflows/publish-release.yml'))).digest('hex'));
