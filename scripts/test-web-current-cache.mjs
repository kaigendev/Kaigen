import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,lstat,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonicalizeContract,computeFingerprint,extractRecipeDescriptor} from './prepared-native-cache.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const options=new Map();
for(let i=2;i<process.argv.length;i+=2){assert(['--input-root','--cache-root','--receipt'].includes(process.argv[i]));assert(process.argv[i+1]&&!options.has(process.argv[i]));options.set(process.argv[i],path.resolve(process.argv[i+1]));}
for(const key of ['--input-root','--cache-root','--receipt'])assert(options.has(key),'Required '+key);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const prepare=await readFile(path.join(root,'scripts/prepare-unix-dependencies.sh'),'utf8');
const tool=await readFile(path.join(root,'scripts/prepared-native-cache.mjs'),'utf8');
const expectedSchema=Number(tool.match(/^const SCHEMA = (\d+);$/m)?.[1]);assert(Number.isSafeInteger(expectedSchema)&&expectedSchema>0,'Current cache schema');
const expectedPolicy=tool.match(/^const POLICY = "([^"]+)";$/m)?.[1];assert(expectedPolicy,'Current cache policy');
const ordinaryDirectory=async filename=>{const stat=await lstat(filename);assert(stat.isDirectory()&&!stat.isSymbolicLink(),'Ordinary cache directory: '+filename);return stat;};
const ordinaryFile=async filename=>{const stat=await lstat(filename);assert(stat.isFile()&&!stat.isSymbolicLink(),'Ordinary cache file: '+filename);return stat;};
const map=tool.match(/const COMPONENTS = Object\.freeze\((\{[\s\S]*?\n\})\);/);assert(map,'Canonical prepared input inventory');
// Parse its literal data, without evaluating project code or silently guessing pins.
const components=JSON.parse(map[1].replace(/^(\s*)([A-Za-z][A-Za-z0-9]*):/gm,'$1"$2":').replace(/,\s*([}\]])/g,'$1'));
const inventory=await readFile(path.join(root,'src/componentVersions.ts'),'utf8');
const versionMap=inventory.match(/export const COMPONENT_VERSIONS = Object\.freeze\((\{[\s\S]*?\n\})\);/);assert(versionMap,'Canonical component inventory');
const versions=JSON.parse(versionMap[1].replace(/^(\s*)([A-Za-z][A-Za-z0-9]*):/gm,'$1"$2":').replace(/,\s*([}\]])/g,'$1'));
assert.equal(components.toxcore.file,`kaigen-toxcore-${versions.cToxcoreCommit}.zip`);
assert(prepare.includes(`toxcore_commit="${versions.cToxcoreCommit}"`));
assert(prepare.includes(`toxcore_sha="${components.toxcore.sha256}"`));
assert.equal(components.sodium.file,`libsodium-${versions.libsodium}.tar.gz`);
assert.equal(components.torLinux.file,`tor-expert-bundle-linux-x86_64-${versions.torExpertBundle}.tar.gz`);
const inputRoot=options.get('--input-root'),cacheRoot=options.get('--cache-root');
for(const [label,component] of Object.entries(components).filter(([name])=>['toxcore','sodium','torLinux'].includes(name))){
  const candidates=[component.file,path.join(component.sha256.toUpperCase(),component.file),path.join(component.sha256,component.file)].map(value=>path.join(inputRoot,value));
  const filename=(await Promise.all(candidates.map(async filename=>(await lstat(filename).catch(()=>null))?filename:null))).find(Boolean);assert(filename,'Missing canonical local '+label);
  const stat=await lstat(filename);assert(stat.isFile()&&!stat.isSymbolicLink(),'Ordinary local cached file');
  const bytes=await readFile(filename);assert.equal(bytes.length,component.size,label+' size');assert.equal(hash(bytes),component.sha256,label+' hash');
}
const receipts=(await readFile(options.get('--receipt'),'utf8')).trim().split(/\r?\n/).map(line=>JSON.parse(line));
assert.equal(receipts.length,3,'Exactly three native managed groups');
assert.deepEqual(receipts.map(item=>item.group).sort(),['c-toxcore','libsodium','tor-universal']);
await ordinaryDirectory(cacheRoot);const checked=[]; const validated=new Map();
for(const receipt of receipts){
  assert.equal(receipt.platform,'linux-x86_64');assert.equal(receipt.disposition,'hit','Must use local prepared cache, never build/download fallback');assert.match(receipt.fingerprint,/^[a-f0-9]{64}$/);
  const entry=path.join(cacheRoot,`schema-${expectedSchema}`,receipt.platform,receipt.group,receipt.fingerprint);
  for(const tombstone of [receipt.fingerprint,receipt.fingerprint+'.json'])assert(!(await lstat(path.join(cacheRoot,'schema-2','revoked',tombstone)).catch(()=>null)),'Entry not revoked');
  assert(!(await lstat(path.join(entry,'REVOKED')).catch(()=>null)),'Entry not locally revoked');
  const entryStat=await ordinaryDirectory(entry);if(process.platform!=='win32')assert.equal(entryStat.mode&0o222,0,'Prepared entry immutable');
  assert.deepEqual((await readdir(entry)).sort(),['contract.tsv','manifest.json','outputs'],'No unexpected cache entry files');
  await ordinaryFile(path.join(entry,'contract.tsv'));await ordinaryFile(path.join(entry,'manifest.json'));await ordinaryDirectory(path.join(entry,'outputs'));
  const text=await readFile(path.join(entry,'contract.tsv'),'utf8'); const contract={};
  for(const line of text.trimEnd().split('\n')){const i=line.indexOf('\t');assert(i>0);const key=line.slice(0,i);assert(!Object.hasOwn(contract,key));contract[key]=line.slice(i+1);}
  assert.equal(canonicalizeContract(contract),text);assert.equal(computeFingerprint(contract),receipt.fingerprint);
  assert.equal(contract.schema,String(expectedSchema));assert.equal(contract.policy,expectedPolicy);
  assert.equal(contract.platform,receipt.platform);assert.equal(contract.group,receipt.group);
  assert.equal(contract['script.preparation_recipe.sha256'],hash(extractRecipeDescriptor(prepare,receipt.group,receipt.platform)),'Current consumer preparation recipe');
  for(const [prefix,component] of receipt.group==='c-toxcore'?[['input.toxcore',components.toxcore],['input.libsodium',components.sodium]]:receipt.group==='libsodium'?[['input.libsodium',components.sodium]]:[['input.tor.x86_64',components.torLinux]]){
    assert.equal(contract[prefix+'.filename'],component.file);assert.equal(contract[prefix+'.size'],String(component.size));assert.equal(contract[prefix+'.sha256'],component.sha256);
  }
  if(receipt.group==='c-toxcore'){assert.equal(contract['source.commit'],versions.cToxcoreCommit);assert.equal(contract['source.materialized_tree'],components.toxcore.materializedTree);assert.equal(contract['source.repository'],'https://github.com/kaigendev/kaigen-toxcore');}
  const manifest=JSON.parse(await readFile(path.join(entry,'manifest.json'),'utf8'));
  assert.equal(manifest.schemaVersion,Number(contract.schema),'Exact numeric manifest schema');assert(Array.isArray(manifest.outputs)&&manifest.outputs.length>0,'Nonempty output manifest');
  assert.equal(manifest.fingerprint,receipt.fingerprint);assert.equal(manifest.contractSha256,receipt.fingerprint);assert.equal(manifest.platform,receipt.platform);assert.equal(manifest.group,receipt.group);assert.equal(manifest.policy,contract.policy);assert.equal(manifest.outputManifestSha256,receipt.outputManifestSha256);
  assert.equal(hash(JSON.stringify(manifest.outputs)+'\n'),receipt.outputManifestSha256,'Output manifest identity');
  const required=receipt.group==='libsodium'?['include/sodium.h','lib/libsodium.a','lib/pkgconfig/libsodium.pc']:receipt.group==='c-toxcore'?['lib/libtoxcore.so']:['tor/tor','tor/pluggable_transports/lyrebird','tor/pluggable_transports/conjure-client'];
  for(const relative of required){const stat=await ordinaryFile(path.join(entry,'outputs',relative));assert(stat.size>0,'Nonempty required '+receipt.group+' output');}
  const actual=[];const walk=async(relative='')=>{for(const child of (await readdir(path.join(entry,'outputs',relative),{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:1)){assert(!child.isSymbolicLink(),'No output symlinks');const rel=relative?relative+'/'+child.name:child.name;if(child.isDirectory())await walk(rel);else{assert(child.isFile());actual.push(rel);}}};await walk();
  assert.deepEqual(actual,manifest.outputs.map(output=>output.path),'No omitted or extra output bytes');
  for(const output of manifest.outputs){assert(typeof output.path==='string'&&output.path.length>0);assert(Number.isSafeInteger(output.size)&&output.size>=0);assert.match(output.sha256,/^[a-f0-9]{64}$/);assert([0o644,0o755].includes(output.mode));const filename=path.resolve(entry,'outputs',output.path);assert(filename.startsWith(path.join(entry,'outputs')+path.sep));const stat=await lstat(filename);const bytes=await readFile(filename);assert.equal(bytes.length,output.size);assert.equal(hash(bytes),output.sha256);if(process.platform!=='win32')assert.equal((stat.mode&0o111)?0o755:0o644,output.mode);}
  validated.set(receipt.group,{contract,manifest});
  checked.push({group:receipt.group,fingerprint:receipt.fingerprint,outputManifestSha256:receipt.outputManifestSha256});
}
const sodium=validated.get('libsodium'),toxcore=validated.get('c-toxcore');
assert.equal(toxcore.contract['dependency.libsodium.fingerprint'],computeFingerprint(sodium.contract),'Current exact prepared libsodium dependency');
assert.equal(toxcore.contract['dependency.libsodium.library.sha256'],sodium.manifest.outputs.find(item=>item.path==='lib/libsodium.a')?.sha256,'Prepared libsodium bytes actually used by toxcore');
console.log(JSON.stringify({finishedAt:new Date().toISOString(),sourcePinsSha256:hash(inventory),preparationSha256:hash(prepare),receiptSha256:hash(await readFile(options.get('--receipt'))),status:'PASS',currentToxcoreCommit:versions.cToxcoreCommit,inputs:'actual local cached bytes',groups:checked,boundary:'Readonly local cache identity, current pins and actual expected-hit receipts; does not rebuild or fetch.'},null,2));
