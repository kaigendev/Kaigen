import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile), script = fileURLToPath(import.meta.url), projectRoot = path.dirname(path.dirname(script));
const values = new Map(), args = process.argv.slice(2);
while (args.length) { const key = args.shift(), value = args.shift();
  assert.ok(['--source-root', '--output-root', '--msvc-root', '--sdk-root', '--expect-before'].includes(key) && value && !values.has(key)); values.set(key,value); }
const sourceRoot = await realpath(values.get('--source-root'));
const outputRoot = path.resolve(values.get('--output-root'));
assert.ok(path.relative(projectRoot, sourceRoot) !== '');
await mkdir(outputRoot, { recursive: true }); assert.equal(await realpath(outputRoot), outputRoot);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function body(text, declaration) {
  const offset = text.indexOf(declaration); assert.ok(offset >= 0 && text.indexOf(declaration,offset+1) < 0);
  const start = text.indexOf('{',offset); let depth=1, end=start+1;
  while(depth && end<text.length) { if(text[end]==='{')depth++;if(text[end]==='}')depth--;end++; }
  assert.equal(depth,0); return text.slice(offset,end);
}
const osBytes = await readFile(path.join(sourceRoot,'toxcore/os_network.c'));
const tcpBytes = await readFile(path.join(sourceRoot,'toxcore/TCP_client.c'));
const header = body(osBytes.toString(),'static Socket sys_socket(')+'\n\n'+body(tcpBytes.toString(),'static int proxy_http_generate_connection_request(')+'\n';
await writeFile(path.join(outputRoot,'network-functions-under-test.h'),header);
const fixture = path.join(projectRoot,'scripts/fixtures/toxcore-network-patch-regression.c');
const reports=[];
for(const platform of ['windows','nonwindows']) {
  const executable=path.join(outputRoot,'regression-'+platform+(process.platform==='win32'?'.exe':''));
  let compiler, command;
  if(process.platform==='win32') {
    const msvc=await realpath(values.get('--msvc-root')),sdk=await realpath(values.get('--sdk-root'));
    compiler=path.join(msvc,'bin/Hostx64/x64/cl.exe');
    command=['/nologo','/std:c11','/W3','/D_CRT_SECURE_NO_WARNINGS',...(platform==='windows'?['/DOS_WIN32']:[]),
      '/I'+outputRoot,'/I'+path.join(msvc,'include'),'/I'+path.join(sdk,'Include/10.0.26100.0/ucrt'),fixture,
      '/Fe:'+executable,'/Fo:'+path.join(outputRoot,'regression-'+platform+'.obj'),'/link',
      '/LIBPATH:'+path.join(msvc,'lib/x64'),'/LIBPATH:'+path.join(sdk,'Lib/10.0.26100.0/ucrt/x64'),'/LIBPATH:'+path.join(sdk,'Lib/10.0.26100.0/um/x64')];
  } else { compiler=process.env.CC||'cc';command=['-std=c11','-Wall',...(platform==='windows'?['-DOS_WIN32']:[]),'-I',outputRoot,fixture,'-o',executable]; }
  await exec(compiler,command,{cwd:outputRoot,windowsHide:true,timeout:30_000,maxBuffer:100_000});
  let stdout,exitCode=0;
  try{stdout=(await exec(executable,[],{cwd:outputRoot,windowsHide:true,timeout:5000})).stdout;}
  catch(error){assert.equal(error.code,1);stdout=error.stdout;exitCode=1;}
  const cases=stdout.trim().split(/\r?\n/).map(line=>{const m=/^(PASS|FAIL) ([a-z0-9_]+)$/.exec(line);assert.ok(m);return{id:m[2],status:m[1]};});
  assert.equal(cases.length,11);
  reports.push({platform,exitCode,passed:cases.filter(x=>x.status==='PASS').length,failed:cases.filter(x=>x.status==='FAIL').length,cases,executableSha256:sha(await readFile(executable))});
}
const before=values.get('--expect-before')==='true';
if(before){for(const row of reports){const expected=['http_ipv4_crlf','http_ipv6_authority','http_ipv6_tcp_authority','http_zero_port_preserved','equal_capacity_rejected'];if(row.platform==='windows')expected.unshift('socket_udp_noninherit','socket_tcp_noninherit','socket_failure_no_fallback');assert.deepEqual(row.cases.filter(x=>x.status==='FAIL').map(x=>x.id),expected);}}
else for(const row of reports)assert.equal(row.failed,0);
const report={schemaVersion:1,kind:'toxcore-network-source-regression',status:before?'EXPECTED_REGRESSIONS_REPRODUCED':'PASS',sourceSha256:{osNetwork:sha(osBytes),tcpClient:sha(tcpBytes)},fixtureSha256:sha(await readFile(fixture)),functionBytesSha256:sha(header),reports,nativeDllBuilt:false,nativeDllLoaded:false,networkUsed:false};
await writeFile(path.join(outputRoot,'regression.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,counts:reports.map(r=>({platform:r.platform,passed:r.passed,failed:r.failed})),reportSha256:sha(JSON.stringify(report,null,2)+'\n')}));
