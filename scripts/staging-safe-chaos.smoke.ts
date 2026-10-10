/** Opt-in Mac safe-chaos gate for DevOS 2, Issue #152.
 * Runs temporary fixture processes only; verifies production/staging
 * listener ownership is unchanged before and after.
 */
import {execFile} from "node:child_process";
import {promisify} from "node:util";
const exec=promisify(execFile);
const portPid=async(port:number):Promise<string>=>{
 const {stdout}=await exec("lsof",["-nP","-t",`-iTCP:${port}`,"-sTCP:LISTEN"],{
   timeout:4000,maxBuffer:32000,
 });
 const ids=stdout.trim().split(/\s+/).filter(Boolean);
 if(ids.length!==1||!/^\d+$/.test(ids[0]!))throw new Error("Unclear listener owner");
 return ids[0]!;
};
const health=async(port:number):Promise<boolean>=>{
 const r=await fetch(`http://127.0.0.1:${port}/health`,{
   signal:AbortSignal.timeout(4000),redirect:"error",
 });
 return r.status===200;
};
const summary=(text:string)=>{
 const pick=(key:string)=>Number(new RegExp(`ℹ ${key} (\\d+)`).exec(text)?.[1]??-1);
 return {total:pick("tests"),passed:pick("pass"),failed:pick("fail"),
   skipped:pick("skipped"),cancelled:pick("cancelled")};
};
const run=async(label:string,args:string[],limit:number)=>{
 const child=await exec("./node_modules/.bin/tsx",args,{
  cwd:process.cwd(),timeout:limit,maxBuffer:12*1024*1024,
 });
 const result=summary(child.stdout);
 if(result.total>=0&&!(result.passed===result.total&&result.failed===0&&
      result.skipped===0&&result.cancelled===0))
   throw new Error(label+" has failing or skipped checks");
 return {label,status:"pass",...result};
};
const proof:Record<string,unknown>={connectorRestartsRequested:false,productionProfileAccessRequested:false,
 tests:[],hostSmoke:false,requiresLiveWebIos:true};
let beforeProd:string|undefined,beforeStaging:string|undefined;
try{
 beforeProd=await portPid(8787);
 beforeStaging=await portPid(8788);
 if(!(await health(8787))||!(await health(8788)))
  throw new Error("Required running gateway health missing");
 const tests=await run("isolated_chaos_suite",[
  "--test","tests/browser-chaos-stress.test.ts",
  "tests/chat-worker-grants.test.ts",
  "tests/browser-recovery.test.ts",
  "tests/shared-browser-runtime.test.ts",
  "tests/connector-auth-crash.test.ts",
  "tests/codex-executor.test.ts",
  "tests/pipeline-diagnostics.test.ts",
 ],120_000);
 (proof.tests as unknown[]).push(tests);
 await exec("./node_modules/.bin/tsx",["tests/shared-browser-runtime.smoke.ts"],{
  cwd:process.cwd(),timeout:70_000,maxBuffer:2*1024*1024,
 });
 proof.hostSmoke=true;
 proof.productionPidStable=beforeProd===await portPid(8787);
 proof.stagingPidStable=beforeStaging===await portPid(8788);
 proof.productionHealth200=await health(8787);
 proof.stagingHealth200=await health(8788);
 if(!proof.productionPidStable||!proof.stagingPidStable||
    !proof.productionHealth200||!proof.stagingHealth200)
  throw new Error("Live gateway changed during isolated QA");
 proof.status="pass_non_destructive_only";
 console.log(JSON.stringify(proof));
}catch(e){
 proof.status="blocked";
 proof.category=/timeout/i.test(String(e))?"timeout":
   /gateway|listener/i.test(String(e))?"gateway_identity":"test_or_host_smoke";
 console.log(JSON.stringify(proof));
 process.exitCode=2;
}
