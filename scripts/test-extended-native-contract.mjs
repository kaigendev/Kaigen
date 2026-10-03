import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseDiscovery, parseRun, executionCounts, validateCatalog, cargoArguments, selectTests } from "./extended-native-verification.mjs";
const root=fileURLToPath(new URL("../",import.meta.url));
let passed=0;
const check=(name,callback)=>{ callback(); passed++; console.log(name+": PASS"); };
const names=["pq::fault::tests::a","pq::v2::tests::b"];
const output="test pq::fault::tests::a ... ok\ntest pq::v2::tests::b ... ok\n\ntest result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 391 filtered out;\n";
check("exact Rust execution counts",()=>assert.equal(parseRun(output,names).executed,2));
check("zero test false pass rejected",()=>assert.throws(()=>parseRun("test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 2 filtered out;\n",names),/incomplete/));
check("ignored selected test rejected",()=>assert.throws(()=>parseRun(output.replace("2 passed; 0 failed; 0 ignored","1 passed; 0 failed; 1 ignored"),names),/skipped/));
check("wrong executed test rejected",()=>assert.throws(()=>parseRun(output.replace("::a ...","::c ..."),names),/wrong Rust/));
check("ambiguous summary rejected",()=>assert.throws(()=>parseRun(output+output,names),/ambiguous/));
check("interleaved fixture stdout retains terminal status and exact test name",()=>assert.equal(parseRun(output.replace("a ... ok","a ... fixture line\nfixture second line\nok"),names).executed,2));
check("interleaved missing terminal rejected",()=>assert.throws(()=>parseRun(output.replace("a ... ok","a ... fixture line"),names),/did not pass/));
check("interleaved failure rejected",()=>assert.throws(()=>parseRun(output.replace("a ... ok","a ... fixture line\nFAILED"),names),/did not pass/));
check("failed/incomplete run retains observations",()=>assert.deepEqual(executionCounts("test pq::fault::tests::a ... FAILED\n"),{completedRows:1,passed:0,failed:1,skipped:0,summaryPresent:false,names:["pq::fault::tests::a"]}));
check("failure dump preserves actual summary counts",()=>assert.equal(executionCounts("test pq::fault::tests::a ... FAILED\n\nfailures:\n  fixture panic details\n\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 391 filtered out;\n").failed,1));
check("zero discovery rejected",()=>assert.throws(()=>parseDiscovery("0 tests, 0 benchmarks"),/zero/));
check("duplicate discovery rejected",()=>assert.throws(()=>parseDiscovery("pq::fault::tests::a: test\npq::fault::tests::a: test\n"),/duplicate/));
const catalog=validateCatalog(JSON.parse(await readFile(path.join(root,"ci/extended-native-jobs.json"),"utf8")));
check("nine current PQ feature tests in both modes and three separate scale jobs",()=>assert.deepEqual(catalog.jobs.map(({group,expectedTests,ignored})=>({group,expectedTests,ignored})),[{group:"pq-faults",expectedTests:9,ignored:false},{group:"pq-faults",expectedTests:9,ignored:false},{group:"scale",expectedTests:1,ignored:true},{group:"scale",expectedTests:1,ignored:true},{group:"scale",expectedTests:1,ignored:true}]));
check("invalid resource bound rejected",()=>{ const altered=structuredClone(catalog); altered.jobs[0].limits.seconds=0; assert.throws(()=>validateCatalog(altered),/resource limit/); });
check("all compile jobs locked and offline",()=>assert.ok(catalog.jobs.every(job=>{const args=cargoArguments(job);return args.includes("--locked")&&args.includes("--offline")&&args.includes("--no-run");})));
check("wrong ignored discovery rejected",()=>assert.throws(()=>selectTests({...catalog.jobs[2],selectors:[names[0]]},names,[]),/ignored mode/));
check("missing feature tests rejected",()=>assert.throws(()=>selectTests(catalog.jobs[0],names,[]),/absent or changed/));
const workflow=await readFile(path.join(root,".github/workflows/regression-extended.yml"),"utf8");
check("applicable PQ gate and opt-in scale registered",()=>{ assert.ok(workflow.includes("pull_request:")&&workflow.includes("pq-fault-desktop")&&workflow.includes("pq-fault-web-core")&&workflow.includes("inputs.run_scale")&&workflow.includes("extended-native-verification.mjs --job")); });
let monitorRuns=0;
if(process.platform==="win32") {
 const directory=await mkdtemp(path.join(tmpdir(),"kaigen-native-monitor-contract-"));
 try {
  for(const [id,code,seconds,memory,violation,exitCode] of [
   ["pass","console.log('preserved-pass-output')",10,256,null,0],
   ["exit","console.log('preserved-failed-output');process.exit(37)",10,256,null,37],
   ["time","console.log('preserved-time-output');setInterval(()=>{},100)",1,256,"time-limit",null],
   ["memory","console.log('preserved-memory-output');const held=Buffer.alloc(128*1024*1024,1);setInterval(()=>held[0],100)",10,96,"working-set-limit",null],
   ["fixture","console.log('preserved-fixture-output');require('node:fs').writeFileSync(require('node:path').join(process.env.TEMP,'canary'),Buffer.alloc(2*1024*1024,1));setInterval(()=>{},100)",10,256,"fixture-limit",null],
  ]) {
   const evidence=path.join(directory,id); await mkdir(evidence);
   const execution=spawnSync("pwsh",["-NoLogo","-NoProfile","-NonInteractive","-File",path.join(root,"scripts/native-test-monitor.ps1"),"-Program",process.execPath,"-ArgumentsJson",JSON.stringify(["-e",code]),"-EvidenceRoot",evidence,"-MaxSeconds",String(seconds),"-MaxWorkingSetMiB",String(memory),"-MaxFixtureMiB",id==="fixture"?"1":"64"],{encoding:"utf8",windowsHide:true,shell:false,timeout:30000});
   assert.equal(execution.status,id==="pass"?0:1,execution.stderr);
   const resource=JSON.parse(await readFile(path.join(evidence,"resource.json"),"utf8"));
   assert.equal(resource.status,id==="pass"?"PASS":"FAIL");
   assert.equal(resource.violation,violation);
   if(exitCode!==null) assert.equal(resource.exitCode,exitCode);
   assert.ok((await readFile(path.join(evidence,"process.stdout.log"),"utf8")).includes("preserved-"));
   assert.ok(resource.peakWorkingSetBytes>0);
   monitorRuns++; passed++; console.log("actual monitor "+id+": PASS");
  }
 } finally {
  assert.ok(directory.startsWith(path.join(tmpdir(),"kaigen-native-monitor-contract-")));
  await rm(directory,{recursive:true,force:true});
 }
}
console.log(JSON.stringify({passed,failed:0,actualMonitorRuns:monitorRuns,platformMonitorSkipped:process.platform==="win32"?0:5}));
