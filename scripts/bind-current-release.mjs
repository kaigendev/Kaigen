// Verification-only: reads explicitly bound files; never starts product, VM, network or tests.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat, realpath, readFile, open} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const REQUIRED_GATES = Object.freeze([
  'platform-windows','platform-debian','platform-macos','platform-web',
  'windows-native-pq','native-entropy','windows-native-functional',
  'desktop-web-functional','web-tablet-functional','browser-engines','web-outer-checkpoint','frozen-rust',
  'ordinary-msi-five','npm-audit','windows-clients-prototype',
  'qtox-desktop','qtox-web','web-full-tor','native-debian-macos-pair','direct-six',
  'proxy-socks-noauth','proxy-socks-auth','proxy-http-noauth','proxy-http-auth',
  'proxy-socks-invalid','proxy-http-invalid','proxy-flags111','proxy-flags000',
  'proxy-switch-live','proxy-switch-restart','builtin-plain','builtin-obfs4',
  'builtin-snowflake','custom-obfs4','route-chain','custom-webtunnel',
]);
export const PUBLIC_ASSETS = Object.freeze(['windows-zip','windows-msi','debian-zip','macos-zip','source-zip','web-bundle','web-bootstrap']);
const SHA=/^[A-Fa-f0-9]{64}$/u, ID=/^[a-z][a-z0-9-]*$/u, COMMIT=/^[a-f0-9]{40}$/u;
const fail=(code)=>{throw new Error(code);};
const need=(condition,code)=>{if(!condition)fail(code);};
export const digest=(bytes)=>createHash('sha256').update(bytes).digest('hex').toUpperCase();
const json=(bytes)=>JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u,''));
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const shaEqual=(a,b)=>SHA.test(a??'')&&SHA.test(b??'')&&a.toUpperCase()===b.toUpperCase();
const CUSTOM_OUTCOMES=Object.freeze({
  'ordinary-msi-five':['ROOT_ACCEPTED_FIVE_ORDINARY_MSI_CASES'],
  'frozen-rust':['FROZEN_SOURCE_RUST_DESKTOP_AND_WEB_FAULT_AND_IGNORED_PASS'],
  'windows-native-pq':['ACTUAL_DEFAULT_NATIVE_PQ_PASS_SEPARATE_PRODUCT_TOKEN_UI_GATES_OPEN'],
});
function acceptedOutcome(c,g){return c.op==='eq'&&(['PASS','pass','COMPLETE'].includes(c.value)||(CUSTOM_OUTCOMES[g.id]??[]).includes(c.value)||(c.value==='WEB_FUNCTIONAL_READY_QTOX_FULLTOR_OPEN'&&g.id==='web-tablet-functional')||(c.value===true&&g.id==='windows-native-functional'&&c.at==='/scopedFunctionalAcceptance')||(c.value===0&&['npm-audit','web-outer-checkpoint','frozen-rust'].includes(g.id)&&['/exitCode','/actualProcessExitCode','/resource/exitCode'].includes(c.at)));}
export function revisionEntries(mode,status,committed,expected){
  need(['dirty','clean-commit'].includes(mode),'REVISION_MODE');
  const names=x=>x.map(c=>c.status+' '+c.path).sort();
  if(mode==='dirty')need(equal(names(status),names(expected)),'VERIFICATION_CHANGE_SET_CHANGED');
  else{need(status.length===0,'FINAL_COMMIT_NOT_CLEAN');const projected=expected.map(c=>({path:c.path,status:c.status==='??'?'A':c.status.trim()}));need(equal(names(committed),names(projected)),'FINAL_COMMIT_DIFF_MISMATCH');}
}
function keys(value,allowed,required=allowed){need(value&&typeof value==='object'&&!Array.isArray(value),'OBJECT_REQUIRED');need(Object.keys(value).every(k=>allowed.includes(k))&&required.every(k=>Object.hasOwn(value,k)),'SCHEMA_FIELDS');}
export function pointer(value,at){
  need(typeof at==='string'&&(at===''||at.startsWith('/')),'JSON_POINTER');
  for(const token of at===''?[]:at.slice(1).split('/')){const k=token.replaceAll('~1','/').replaceAll('~0','~');need(value!==null&&typeof value==='object'&&Object.hasOwn(value,k),'MISSING_RECEIPT_FIELD');value=value[k];}
  return value;
}
function relative(value){need(typeof value==='string'&&value.length>0&&!path.isAbsolute(value)&&!value.includes('\\')&&!value.split('/').some(x=>['','..','.'].includes(x)),'RELATIVE_PATH');return value;}
export function validateManifest(m){
  keys(m,['schema','kind','validatorSha256','candidate','verification','files','artifacts','gates','publication','supplemental']);
  need(SHA.test(m.validatorSha256),'VALIDATOR_PIN');
  need(m.schema===1&&m.kind==='kaigen-current-release-integral-inputs','MANIFEST_KIND');
  keys(m.candidate,['version','buildId','commit','tree','sourceArchiveSha256','materializations']);
  need(m.candidate.version==='0.2.9.8'&&/^release-v0298-[a-f0-9]{12}-[a-f0-9]{12}$/u.test(m.candidate.buildId),'CANDIDATE_ID');
  need(COMMIT.test(m.candidate.commit)&&COMMIT.test(m.candidate.tree)&&SHA.test(m.candidate.sourceArchiveSha256),'CANDIDATE_HASH');
  need(Array.isArray(m.candidate.materializations)&&m.candidate.materializations.every(x=>COMMIT.test(x.commit)&&x.tree===m.candidate.tree),'MATERIALIZATION_TREE');
  keys(m.verification,['head','tree','changes','appSummary','appInputs','state','mode','extensions']);
  need(['dirty','clean-commit'].includes(m.verification.mode)&&Array.isArray(m.verification.extensions),'REVISION_MODE');
  for(const x of m.verification.extensions){keys(x,['path','classification','sha256']);need(x.path==='scripts/bind-current-release.mjs'&&x.classification==='verification-only'&&shaEqual(x.sha256,m.validatorSha256),'UNAPPROVED_VERIFICATION_EXTENSION');}
  need(COMMIT.test(m.verification.head)&&COMMIT.test(m.verification.tree)&&['REVIEW_PENDING','BOUND'].includes(m.verification.state),'VERIFICATION_IDENTITY');
  need(Array.isArray(m.verification.changes),'VERIFICATION_CHANGES');
  const changed=new Set();
  for(const x of m.verification.changes){keys(x,['path','status','sha256']);relative(x.path);need(!changed.has(x.path),'DUPLICATE_CHANGE');changed.add(x.path);need([' M',' D','??'].includes(x.status)&&(x.status===' D'?x.sha256===null:SHA.test(x.sha256)),'CHANGE_BINDING');}
  need(m.files&&typeof m.files==='object'&&!Array.isArray(m.files),'FILE_BINDINGS');
  for(const [id,f] of Object.entries(m.files)){need(ID.test(id),'FILE_ID');keys(f,['root','path','sha256','bytes','format']);need(ID.test(f.root)&&SHA.test(f.sha256)&&Number.isSafeInteger(f.bytes)&&f.bytes>=0&&['json','bytes','tsv'].includes(f.format),'FILE_BINDING');relative(f.path);}
  const ref=id=>need(Object.hasOwn(m.files,id),'UNKNOWN_FILE_BINDING');
  need(Array.isArray(m.supplemental),'SUPPLEMENTAL');
  for(const s of m.supplemental){keys(s,['id','file','artifactSha256','feature','builtFromCommit','builtFromTree','scope']);ref(s.file);need(s.id==='native-fault-31'&&SHA.test(s.artifactSha256)&&s.feature==='pq-fault-tests'&&s.builtFromCommit===m.candidate.commit&&s.builtFromTree===m.candidate.tree&&s.scope==='diagnostic-risk-only','SUPPLEMENTAL_SCOPE');}
  ref(m.verification.appSummary);ref(m.verification.appInputs);
  need(m.artifacts&&typeof m.artifacts==='object'&&!Array.isArray(m.artifacts),'ARTIFACTS');
  for(const [id,a] of Object.entries(m.artifacts)){need(ID.test(id),'ARTIFACT_ID');keys(a,['file','builtFrom','role']);need(['shipping','test','source-snapshot','diagnostic'].includes(a.role),'ARTIFACT_ROLE');ref(a.file);keys(a.builtFrom,['commit','tree','archiveSha256']);need(a.builtFrom.tree===m.candidate.tree&&(a.builtFrom.archiveSha256===null||SHA.test(a.builtFrom.archiveSha256)),'ARTIFACT_SOURCE');need(a.builtFrom.commit===m.candidate.commit||m.candidate.materializations.some(x=>x.commit===a.builtFrom.commit&&x.tree===a.builtFrom.tree),'ARTIFACT_COMMIT');}
  need(Array.isArray(m.gates)&&equal([...m.gates.map(x=>x.id)].sort(),[...REQUIRED_GATES].sort()),'REQUIRED_GATE_SET');
  for(const g of m.gates){
    keys(g,['id','state','disposition','reason','evidence','checks','artifacts','runnerInputs','runnerMode','completed','applicability']);
    need(['direct-bytes','owner-receipt','recorded-command'].includes(g.runnerMode),'RUNNER_MODE');
    if(g.runnerMode==='owner-receipt')need(g.id.startsWith('platform-')||g.id==='web-tablet-functional','OWNER_RECEIPT_ONLY_PLATFORM');
    if(g.runnerMode==='recorded-command')need(['frozen-rust','npm-audit'].includes(g.id),'RECORDED_COMMAND_SCOPE');
    need(['OPEN','EVIDENCE','NOT_APPLICABLE'].includes(g.state)&&['new','reused','missing'].includes(g.disposition),'GATE_STATE');
    need(typeof g.reason==='string'&&/^[A-Z0-9_]*$/u.test(g.reason),'REASON_CODE');
    for(const id of [...g.evidence,...g.runnerInputs])ref(id);
    need(g.artifacts.every(id=>Object.hasOwn(m.artifacts,id)),'GATE_ARTIFACT');
    for(const id of g.artifacts){const role=m.artifacts[id].role;need(role!=='diagnostic','DIAGNOSTIC_NOT_RELEASE_GATE');need(role!=='test'||['browser-engines','web-outer-checkpoint'].includes(g.id),'TEST_ARTIFACT_SCOPE');need(role!=='source-snapshot'||['frozen-rust','npm-audit'].includes(g.id),'SOURCE_SNAPSHOT_SCOPE');}
    need(Array.isArray(g.checks),'GATE_CHECKS');
    for(const c of g.checks){keys(c,['file','at','op','value','role']);ref(c.file);need(['eq','sha','nonempty','empty','timestamp','length'].includes(c.op)&&['outcome','source','artifact','runner','behavior','cleanup','provenance'].includes(c.role),'CHECK_KIND');need(m.files[c.file].format==='json','CHECK_JSON');need(typeof c.at==='string'&&c.at.startsWith('/'),'CHECK_POINTER');}
    if(g.state==='EVIDENCE'){
      need(g.disposition!=='missing'&&g.evidence.length>0&&g.artifacts.length>0&&(g.runnerMode==='owner-receipt'||g.runnerInputs.length>0),'EVIDENCE_CLOSURE');
      for(const role of ['outcome','source','artifact','runner','behavior','cleanup'])need(g.checks.some(c=>c.role===role),'EVIDENCE_ROLE_MISSING');
      need(g.completed&&typeof g.completed==='object','COMPLETION_REQUIRED');keys(g.completed,['file','at','kind'],['file','at']);ref(g.completed.file);need(m.files[g.completed.file].format==='json'&&typeof g.completed.at==='string'&&g.completed.at.startsWith('/'),'COMPLETION_POINTER');need(g.completed.kind===undefined||['execution-completed','receipt-recorded','post-cleanup-observation'].includes(g.completed.kind),'COMPLETION_KIND');
      need(g.checks.filter(c=>c.role==='outcome').every(c=>acceptedOutcome(c,g)),'OUTCOME_CANNOT_ACCEPT_FAILURE');
      if(g.checks.some(c=>c.role==='outcome'&&c.value==='WEB_FUNCTIONAL_READY_QTOX_FULLTOR_OPEN'))need(g.id==='web-tablet-functional','WEB_PARTIAL_NOT_PLATFORM_COMPLETE');
      need(g.checks.filter(c=>c.role==='source').every(c=>['eq','sha'].includes(c.op)&&[m.candidate.commit,m.candidate.tree,m.candidate.sourceArchiveSha256,...m.candidate.materializations.map(x=>x.commit)].includes(c.value)),'REUSE_SOURCE_MISMATCH');
      need(g.checks.filter(c=>c.role==='artifact').every(c=>c.op==='sha'&&g.artifacts.some(id=>shaEqual(c.value,m.files[m.artifacts[id].file].sha256))),'REUSE_ARTIFACT_MISMATCH');
      need(g.checks.filter(c=>c.role==='runner').every(c=>c.op==='sha'&&SHA.test(c.value)&&(g.runnerMode==='owner-receipt'||g.runnerInputs.some(id=>shaEqual(c.value,m.files[id].sha256)))||g.runnerMode==='recorded-command'&&c.op==='eq'&&c.at==='/execSessionId'&&Number.isSafeInteger(c.value)&&c.value>0),'RUNNER_IDENTITY_MISMATCH');
    }
    if(g.state==='NOT_APPLICABLE'){
      need(g.id==='custom-webtunnel'&&g.applicability&&g.applicability.offered===false,'CONDITIONAL_ONLY');ref(g.applicability.file);
      need(g.applicability.at.startsWith('/')&&g.applicability.checkedAt.startsWith('/'),'APPLICABILITY_POINTER');
    }
  }
  need(Array.isArray(m.publication)&&equal(m.publication.map(x=>x.id).sort(),[...PUBLIC_ASSETS].sort()),'PUBLIC_SEVEN_ONLY');
  for(const a of m.publication){keys(a,['id','name','artifact','state']);need(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(a.name),'PUBLIC_NAME');need(a.state==='FINAL_PENDING'||a.state==='CANDIDATE_ONLY','PUBLIC_STATE');need(a.artifact===null||Object.hasOwn(m.artifacts,a.artifact)&&m.artifacts[a.artifact].role==='shipping','PUBLIC_ARTIFACT');}
  return m;
}
async function ordinary(root,rel){
  root=path.resolve(root);const target=path.resolve(root,...relative(rel).split('/'));need(target.startsWith(root+path.sep),'PATH_ESCAPE');
  let cursor=path.parse(root).root;
  for(const part of path.relative(cursor,target).split(path.sep)){cursor=path.join(cursor,part);const s=await lstat(cursor);need(!s.isSymbolicLink(),'REPARSE_REFUSED');}
  const actual=await realpath(target);need(actual.toLowerCase()===target.toLowerCase(),'REALPATH_DRIFT');return target;
}
async function fingerprint(file){const h=createHash('sha256');let bytes=0;for await(const chunk of createReadStream(file)){h.update(chunk);bytes+=chunk.length;}return {sha256:h.digest('hex').toUpperCase(),bytes};}
async function checkFile(f,roots){need(Object.hasOwn(roots,f.root),'OWNER_ROOT_NOT_ADMITTED');const file=await ordinary(roots[f.root],f.path);need((await lstat(file)).isFile(),'FILE_REQUIRED');const actual=await fingerprint(file);need(actual.bytes===f.bytes&&shaEqual(actual.sha256,f.sha256),'FILE_HASH_MISMATCH');return file;}
async function snapshot(file,binding){const raw=await readFile(file);need(raw.length===binding.bytes&&shaEqual(digest(raw),binding.sha256),'DEPENDENCY_SNAPSHOT_MISMATCH');return raw;}
export async function bind(m,{roots,sourceRoot,manifestSha256,scriptSha256,checkSource=true}){
  validateManifest(m);
  need(shaEqual(m.validatorSha256,scriptSha256),'VALIDATOR_HASH_MISMATCH');
  const issues=[],verified=new Map(),documents=new Map();
  const record=(scope,code)=>issues.push({scope,code});
  for(const [id,f] of Object.entries(m.files)){
    try{const p=await checkFile(f,roots);verified.set(id,p);if(f.format==='json'){need(f.bytes<=1024*1024,'JSON_TOO_LARGE');documents.set(id,json(await snapshot(p,f)));}}
    catch(e){record(id,/^[A-Z_]+$/u.test(e.message)?e.message:'FILE_UNAVAILABLE');}
  }
  const doc=id=>{need(documents.has(id),'DEPENDENCY_NOT_VERIFIED');return documents.get(id);};
  try{
    const summary=doc(m.verification.appSummary);
    need(['APPLICATION_INPUT_EQUIVALENCE_CONFIRMED_VERIFICATION_REVISION_DIRTY','APPLICATION_INPUT_EQUIVALENCE_CONFIRMED'].includes(summary.status),'APP_PROOF_STATUS');
    need(summary.builtFrom.head===m.candidate.commit&&summary.builtFrom.tree===m.candidate.tree&&shaEqual(summary.builtFrom.sourceArchiveSha256,m.candidate.sourceArchiveSha256),'APP_REUSE_MISMATCH');
    need(shaEqual(summary.details.sha256,m.files[m.verification.appInputs].sha256),'APP_TABLE_IDENTITY');
    need(verified.has(m.verification.appInputs),'APP_TABLE_UNVERIFIED');
    const rows=(await snapshot(verified.get(m.verification.appInputs),m.files[m.verification.appInputs])).toString('utf8').trimEnd().split(/\r?\n/u);
    need(rows.shift()==='file\theadSha256\tcurrentSha256\tfrozenSha256\trawCurrentEqualsHead\trawCurrentEqualsFrozen\texplicitEolOnly','APP_TABLE_SCHEMA');
    need(rows.length===summary.counts.checkedApplicationBuild&&rows.length===summary.selection.selectedApplicationBuildFiles,'APP_TABLE_COUNT');
    const seen=new Set();
    for(const line of rows){const [rel,head,current,frozen,eqHead,eqFrozen,eol]=line.split('\t');relative(rel);need(!seen.has(rel),'APP_DUPLICATE');seen.add(rel);need([head,current,frozen].every(x=>SHA.test(x))&&[eqHead,eqFrozen,eol].every(x=>['true','false'].includes(x)),'APP_TABLE_ROW');if(checkSource){const p=await ordinary(sourceRoot,rel);need(shaEqual((await fingerprint(p)).sha256,current),'CURRENT_APP_INPUT_CHANGED');}}
    if(checkSource){
      const run=promisify(execFile), gitArgs=['-c','safe.directory='+path.resolve(sourceRoot).replaceAll('\\','/'),'-C',sourceRoot];
      const currentHead=(await run('git',[...gitArgs,'rev-parse','HEAD'],{windowsHide:true})).stdout.trim();need(currentHead===m.verification.head,'SOURCE_HEAD_CHANGED');
      const currentTree=(await run('git',[...gitArgs,'rev-parse','HEAD^{tree}'],{windowsHide:true})).stdout.trim();need(currentTree===m.verification.tree,'SOURCE_TREE_CHANGED');
      need(equal(summary.selection.roots,['src/','src-tauri/','web/','public/','runtime/','vendor/','cmake/','packaging/','patches/'])&&summary.selection.allTopLevelTrackedFiles===true,'APP_SELECTION_SCOPE');
      const tracked=(await run('git',[...gitArgs,'ls-files','-z'],{windowsHide:true,maxBuffer:4*1024*1024})).stdout.split('\0').filter(Boolean);
      const selected=tracked.filter(rel=>!rel.includes('/')||summary.selection.roots.some(prefix=>rel.startsWith(prefix))||summary.selection.exactBuildScripts.includes(rel));
      need(equal([...seen].sort(),selected.sort()),'APP_TRACKED_SET_CHANGED');
      const status=(await run('git',[...gitArgs,'status','--porcelain=v1','--untracked-files=all','-z'],{windowsHide:true,maxBuffer:1024*1024})).stdout;
      const entries=status.split('\0').filter(Boolean).map(x=>({status:x.slice(0,2),path:x.slice(3)}));
      let committed=[];
      if(m.verification.mode==='clean-commit'){
        await run('git',[...gitArgs,'merge-base','--is-ancestor',m.candidate.commit,currentHead],{windowsHide:true});
        const delta=(await run('git',[...gitArgs,'diff','--name-status','-z','--no-renames',m.candidate.commit,currentHead],{windowsHide:true,maxBuffer:1024*1024})).stdout.split('\0').filter(Boolean);need(delta.length%2===0,'FINAL_DIFF_FORMAT');
        for(let i=0;i<delta.length;i+=2)committed.push({status:delta[i],path:delta[i+1]});
      }else need(currentHead===m.candidate.commit&&currentTree===m.candidate.tree,'DIRTY_BASE_CHANGED');
      revisionEntries(m.verification.mode,entries,committed,m.verification.changes);
      const approved=[...summary.changes.map(x=>x.status+' '+x.file),...m.verification.extensions.map(x=>'?? '+x.path)].sort();
      need(equal(approved,m.verification.changes.map(x=>x.status+' '+x.path).sort()),'VERIFICATION_ALLOWLIST_CHANGED');
      for(const x of m.verification.extensions)need(shaEqual(m.verification.changes.find(c=>c.path===x.path)?.sha256,x.sha256),'EXTENSION_BYTE_MISMATCH');
      for(const c of m.verification.changes){if(c.status===' D')continue;need(shaEqual((await fingerprint(await ordinary(sourceRoot,c.path))).sha256,c.sha256),'VERIFICATION_FILE_CHANGED');}
    }
    need(m.verification.state==='BOUND','VERIFICATION_REVIEW_PENDING');
  }catch(e){record('application-equivalence',/^[A-Z_]+$/u.test(e.message)?e.message:'APPLICATION_CHECK_FAILED');}
  const results=[];
  for(const g of m.gates){
    if(g.state==='OPEN'){results.push({id:g.id,status:g.disposition==='missing'?'MISSING':'UNBOUND',reason:g.reason,disposition:g.disposition});continue;}
    try{
      if(g.state==='NOT_APPLICABLE'){const d=doc(g.applicability.file);need(pointer(d,g.applicability.at)===false,'BRIDGE_OFFER_NOT_PROVED');need(Number.isFinite(Date.parse(pointer(d,g.applicability.checkedAt))),'APPLICABILITY_TIME');results.push({id:g.id,status:'NOT_APPLICABLE',evidenceSha256:m.files[g.applicability.file].sha256});continue;}
      for(const id of [...g.evidence,...g.runnerInputs,...g.artifacts.map(x=>m.artifacts[x].file)])need(verified.has(id),'DEPENDENCY_NOT_VERIFIED');
      for(const c of g.checks){const actual=pointer(doc(c.file),c.at);let ok=false;
        if(c.op==='eq')ok=equal(actual,c.value);if(c.op==='sha')ok=shaEqual(actual,c.value);
        if(c.op==='nonempty')ok=(typeof actual==='string'||Array.isArray(actual))&&actual.length>0;
        if(c.op==='empty')ok=Array.isArray(actual)&&actual.length===0;
        if(c.op==='timestamp')ok=typeof actual==='string'&&Number.isFinite(Date.parse(actual));
        if(c.op==='length')ok=Array.isArray(actual)&&Number.isSafeInteger(c.value)&&actual.length===c.value;
        need(ok,'RECEIPT_ASSERTION_FAILED');
      }
      const completedAt=pointer(doc(g.completed.file),g.completed.at);need(typeof completedAt==='string'&&Number.isFinite(Date.parse(completedAt)),'COMPLETION_TIME');
      results.push({id:g.id,status:'BOUND',disposition:g.disposition,originalTimestamp:completedAt,timestampKind:g.completed.kind??'execution-completed',evidenceSha256:g.evidence.map(id=>m.files[id].sha256),runnerMode:g.runnerMode,runnerIdentity:g.checks.filter(c=>c.role==='runner').map(c=>({op:c.op,value:c.value})),artifactRoles:g.artifacts.map(id=>({id,role:m.artifacts[id].role}))});
    }catch(e){results.push({id:g.id,status:'UNBOUND',reason:/^[A-Z_]+$/u.test(e.message)?e.message:'RECEIPT_UNAVAILABLE',disposition:g.disposition});}
  }
  // Rehash all verified dependencies after evaluation: a report cannot mix changed inputs.
  for(const [id,p] of verified){try{need(shaEqual((await fingerprint(p)).sha256,m.files[id].sha256),'DEPENDENCY_CHANGED_DURING_BIND');}catch{record(id,'DEPENDENCY_CHANGED_DURING_BIND');}}
  const complete=checkSource&&issues.length===0&&results.every(x=>['BOUND','NOT_APPLICABLE'].includes(x.status));
  return {schema:1,kind:'kaigen-current-release-integral-result',status:complete?'PASS':'INCOMPLETE',scope:'candidate-runtime-evidence-binding',runtimeExecuted:false,sourceModified:false,publicationAuthorized:false,publicationReady:false,createdAt:new Date().toISOString(),
    candidate:{version:m.candidate.version,buildId:m.candidate.buildId,commit:m.candidate.commit,tree:m.candidate.tree,sourceArchiveSha256:m.candidate.sourceArchiveSha256},
    verificationRevision:{head:m.verification.head,tree:m.verification.tree,mode:m.verification.mode,baseCommit:m.candidate.commit,baseTree:m.candidate.tree,filesSha256:digest(JSON.stringify(m.verification.changes)),state:m.verification.state},
    manifestSha256,validatorSha256:scriptSha256,nodeVersion:process.version,verifiedFileCount:verified.size,issues,gates:results,
    supplemental:m.supplemental.map(s=>({id:s.id,scope:s.scope,status:verified.has(s.file)?'RECORDED_NOT_RELEASE_GATE':'UNVERIFIED_NOT_RELEASE_GATE',originalReceiptSha256:m.files[s.file].sha256,artifactSha256:s.artifactSha256,feature:s.feature,builtFromCommit:s.builtFromCommit,builtFromTree:s.builtFromTree})),
    publication:m.publication.map(a=>({id:a.id,name:a.name,state:a.state,sha256:a.artifact?m.files[m.artifacts[a.artifact].file].sha256:null})),
    privacy:{privateManifestPublished:false,pathsExported:false,receiptContentsExported:false,packagingPerformed:false},
    limitations:['Original receipt statuses, timestamps and built-from identities are preserved. BOUND means checked evidence, never a newly executed test. BF83 binds only web-tablet-functional; platform-web requires its own complete receipt. Separate Web qTox and full Tor gates remain mandatory.','Owner-receipt runner identities on platform units and their scoped Web functional leaf are delegated provenance, not a claim that old VM runner bytes were re-read locally.','Final clean verification revision, source archive composition/privacy, publication and local finish remain separate release steps.']};
}
async function main(args){
  const o={},roots={};for(let i=0;i<args.length;i+=2){const k=args[i],v=args[i+1];need(v!==undefined,'CLI_VALUE');if(k==='--root'){const pos=v.indexOf('=');need(pos>0,'ROOT_ARGUMENT');const name=v.slice(0,pos);need(ID.test(name)&&!roots[name]&&path.isAbsolute(v.slice(pos+1)),'ROOT_ARGUMENT');roots[name]=v.slice(pos+1);}else{need(['--manifest','--manifest-sha256','--source-root','--output'].includes(k)&&!o[k],'CLI_ARGUMENT');o[k]=v;}}
  need(Object.keys(o).length===4&&roots.main&&path.isAbsolute(o['--source-root']),'CLI_REQUIRED');
  const rel=path.relative(roots.main,path.resolve(o['--manifest'])).split(path.sep).join('/');const manifestPath=await ordinary(roots.main,rel);
  const raw=await readFile(manifestPath);need(raw.length<=1024*1024&&shaEqual(digest(raw),o['--manifest-sha256']),'MANIFEST_HASH');
  const out=path.resolve(o['--output']);need(path.dirname(out)===path.dirname(manifestPath)&&out!==manifestPath,'OUTPUT_PRIVATE_SIBLING');
  const result=await bind(json(raw),{roots,sourceRoot:o['--source-root'],manifestSha256:digest(raw),scriptSha256:digest(await readFile(new URL(import.meta.url)))});
  const handle=await open(out,'wx');try{await handle.writeFile(JSON.stringify(result,null,2)+'\n');}finally{await handle.close();}
  console.log(JSON.stringify({status:result.status,bound:result.gates.filter(x=>x.status==='BOUND').length,missing:result.gates.filter(x=>x.status==='MISSING').length,issues:result.issues.length}));if(result.status!=='PASS')process.exitCode=2;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){try{await main(process.argv.slice(2));}catch(e){console.error(/^[A-Z_]+$/u.test(e.message)?e.message:'INTEGRAL_BINDING_FAILED');process.exitCode=1;}}
