import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDiscovery, parseRun, validateCatalog, selectTests, cargoArguments, sourceIdentity } from "./extended-native-verification.mjs";
const root=fileURLToPath(new URL("../",import.meta.url));
const sha=(bytes)=>createHash("sha256").update(bytes).digest("hex");
const json=async(filename)=>JSON.parse(await readFile(filename,"utf8"));
const same=(a,b)=>assert.deepEqual(a,b);
export async function verifyRecordedExecution({record,producerSnapshot,catalogSnapshot}) {
 const bytes=await readFile(record), receipt=JSON.parse(bytes);
 assert.equal(receipt.kind,"kaigen-extended-native-result");
 assert.equal(receipt.schema,1);
 const catalog=validateCatalog(await json(path.join(root,"ci/extended-native-jobs.json")));
 const job=catalog.jobs.find((job)=>job.id===receipt.job);
 assert.ok(job,"unknown recorded job");
 assert.ok(receipt.source.inputs.length>0 && new Set(receipt.source.inputs.map(item=>item.path)).size===receipt.source.inputs.length);
 const originalProducer=receipt.source.inputs.find(item=>item.path==="scripts/extended-native-verification.mjs");
 assert.equal(sha(await readFile(producerSnapshot)),originalProducer?.sha256,"original producer snapshot differs");
 const changed=["scripts/extended-native-verification.mjs"];
 const catalogInput=receipt.source.inputs.find(item=>item.path==="ci/extended-native-jobs.json");
 if(catalogSnapshot) {
  const snapshot=await readFile(catalogSnapshot);
  assert.equal(sha(snapshot),catalogInput?.sha256,"original catalog snapshot differs");
  same(validateCatalog(JSON.parse(snapshot)).jobs.find(item=>item.id===job.id),job);
  changed.push("ci/extended-native-jobs.json");
 }
 const current=await sourceIdentity(job);
 same(current.inputs.filter(item=>!changed.includes(item.path)).map(({path,sha256})=>({path,sha256})),
      receipt.source.inputs.filter(item=>!changed.includes(item.path)).map(({path,sha256})=>({path,sha256})));
 const artifact=receipt.build;
 assert.equal(sha(await readFile(artifact.executable)),artifact.artifact.sha256,"compiled test artifact changed");
 assert.equal(path.resolve(root,artifact.artifact.path),path.resolve(artifact.executable));
 assert.equal(artifact.cargoArtifact.executable,artifact.executable);
 assert.equal(artifact.cargoArtifact.profile.test,true);
 same(artifact.command.args,cargoArguments(job));
 for(const feature of job.features) assert.ok(artifact.cargoArtifact.features.includes(feature));
 assert.equal(artifact.cargoArtifact.profile.opt_level,job.profile==="release"?"3":"0");
 const selectedCargo=receipt.toolchain.tools.find(tool=>tool.program==="cargo");
 assert.ok(artifact.command.program==="cargo"||artifact.command.program===selectedCargo.executable,"recorded Cargo command changed");
 const directory=path.dirname(record);
 const all=parseDiscovery(await readFile(path.join(directory,"discovery/stdout.log"),"utf8"));
 const ignoredOutput=await readFile(path.join(directory,"ignored-discovery/stdout.log"),"utf8");
 const ignored=ignoredOutput.trim()?parseDiscovery(ignoredOutput):[];
 const selected=selectTests(job,all,ignored);
 same(receipt.discovery.names,all); same(receipt.discovery.ignoredNames,ignored); same(receipt.discovery.selectedNames,selected);
 assert.equal(receipt.discovery.total,all.length); assert.equal(receipt.discovery.excluded,all.length-selected.length);
 same(receipt.command,{program:artifact.executable,args:[...selected,"--exact",...(job.ignored?["--ignored"]:[]),"--nocapture","--test-threads=1"]});
 assert.equal(receipt.selectedMode,job.ignored?"ignored-only":"ordinary");
 const resourcePath=path.join(directory,"runtime/resource.json"),resource=await json(resourcePath);
 same(resource,receipt.resource);
 assert.equal(resource.status,"PASS"); assert.equal(resource.exitCode,0); assert.equal(resource.violation,null);
 same(resource.limits,job.limits);
 assert.ok(resource.elapsedMs>0&&resource.elapsedMs<=job.limits.seconds*1000);
 assert.ok(resource.peakWorkingSetBytes>0&&resource.peakWorkingSetBytes<=job.limits.workingSetMiB*1024*1024);
 assert.ok(resource.sampledPeakFixtureBytes<=job.limits.fixtureMiB*1024*1024);
 const bindings=[];
 for(const candidate of receipt.runtimeLibraryCandidates) {
  const name=path.basename(candidate.path).toLowerCase();
  const loaded=resource.loadedNativeModules.find(item=>path.basename(item.path).toLowerCase()===name);
  const prepared=receipt.source.inputs.find(item=>item.path===(name==="toxcore.dll"?"work/build/toxcore-native-windows/toxcore.dll":"work/deps/pthreads4w-dynamic/pthreadVC3.dll"));
  assert.equal(candidate.sha256,prepared?.sha256);
  if(!loaded&&name!=="toxcore.dll") {bindings.push({name,disposition:"not-observed"});continue;}
  assert.ok(loaded,"toxcore was not observed in native process");
  assert.equal(path.resolve(loaded.path).toLowerCase(),path.resolve(root,candidate.path).toLowerCase());
  assert.equal(loaded.sha256.toLowerCase(),candidate.sha256);
  assert.equal(sha(await readFile(loaded.path)),candidate.sha256);
  bindings.push({name,disposition:"loaded-and-verified",...loaded});
 }
 const stdoutPath=path.join(directory,"runtime/process.stdout.log"),stderrPath=path.join(directory,"runtime/process.stderr.log");
 const stdout=await readFile(stdoutPath,"utf8"),stderr=await readFile(stderrPath,"utf8");
 const output={stdoutSha256:sha(stdout),stderrSha256:sha(stderr)};
 if(receipt.output) same(output,receipt.output);
 const counts=parseRun(stdout+"\n"+stderr,selected);
 assert.equal(counts.filteredOut,all.length-selected.length);
 if(receipt.counts) same(counts,receipt.counts);
 return {schema:1,kind:"kaigen-native-execution-reanalysis",status:"PASS",job:job.id,operation:"verify-preserved-native-execution; no native rerun",
  originalWrapperStatus:receipt.status,originalWrapperError:receipt.error??null,
  originalExecution:{startedAt:receipt.startedAt,completedAt:receipt.completedAt,recordSha256:sha(bytes),artifact:artifact.artifact,sourceSha256:receipt.source.sha256},
  producerSnapshotSha256:originalProducer.sha256,reviewedConsumerChanges:changed,
  currentConsumerSha256:sha(await readFile(path.join(root,"scripts/extended-native-verification.mjs"))),
  verifierSha256:sha(await readFile(fileURLToPath(import.meta.url))),
  cargoProvenance:artifact.command.program==="cargo"?"PATH command recorded; rustup metadata is selected-toolchain candidate":"exact recorded Cargo executable",
  discovered:all.length,ignoredAvailable:ignored.length,selected:selected.length,counts,resource,runtimeBindings:bindings,output,
  verifiedAt:new Date().toISOString()};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const options={};
 for(let index=2;index<process.argv.length;index+=2) {
  const key=process.argv[index],value=process.argv[index+1];
  assert.ok(["--record","--producer-snapshot","--catalog-snapshot","--result"].includes(key)&&value&&!options[key],"invalid reanalysis arguments");
  options[key]=value;
 }
 assert.ok(options["--record"]&&options["--producer-snapshot"]&&options["--result"]);
 const result=await verifyRecordedExecution({record:path.resolve(options["--record"]),producerSnapshot:path.resolve(options["--producer-snapshot"]),catalogSnapshot:options["--catalog-snapshot"]?path.resolve(options["--catalog-snapshot"]):undefined});
 await writeFile(path.resolve(options["--result"]),JSON.stringify(result,null,2)+"\n",{flag:"wx"});
 console.log(JSON.stringify({job:result.job,status:result.status,operation:result.operation,discovered:result.discovered,counts:result.counts,resource:result.resource}));
}
