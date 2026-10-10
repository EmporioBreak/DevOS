/**
 * Optional, Production-only non-destructive recovery/stress baseline (#152).
 * Does NOT run an actual ChatGPT worker turn, touch the existing Camoufox
 * profile, start Staging MCP, or collect/print authorization secrets.
 */
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {resolve} from "node:path";
const exec=promisify(execFile);

export function parseTestSummary(stdout:string){
  const pick=(key:string)=>Number(new RegExp(`ℹ ${key} (\\d+)`).exec(stdout)?.[1]??-1);
  return {tests:pick("tests"),passed:pick("pass"),failed:pick("fail"),
    skipped:pick("skipped"),cancelled:pick("cancelled")};
}
export function validTestSummary(report:ReturnType<typeof parseTestSummary>){
  return report.tests>0&&report.passed===report.tests&&report.failed===0&&
    report.skipped===0&&report.cancelled===0;
}
export function outcome(checks:Record<string,boolean>,tests:ReturnType<typeof parseTestSummary>,hostSmoke:boolean){
  return {status:Object.values(checks).every(Boolean)&&validTestSummary(tests)&&hostSmoke
    ?"pass_non_destructive_only":"blocked",
    scope:"isolated_production_safe_chaos_not_live_web_ios",
    checks,tests,hostSmoke,stagingStarted:false,productionRestarted:false,
    currentProductionProfileAccessed:false,liveBrowserWorkersLaunched:false,
    independentlyVerifiedE2e:[],mayCloseEpic:false};
}
async function cmd(exe:string,args:string[],timeout=15_000){
  const result=await exec(exe,args,{timeout,maxBuffer:12*1024*1024});
  return result.stdout.trim();
}
async function health(){
  const result=await fetch('http://127.0.0.1:8787/health',{
    redirect:'error',signal:AbortSignal.timeout(4_000)});
  return result.status===200;
}
async function owner(port:number){
  try{
    const text=await cmd('/usr/sbin/lsof',['-nP','-t',`-iTCP:${port}`,'-sTCP:LISTEN'],5_000);
    const pids=text.split(/\s+/).filter(Boolean);
    return pids.length===1&&/^\d+$/.test(pids[0]!)?pids[0]!:null;
  }catch(error){
    if((error as {code?:number}).code===1)return null;
    throw error;
  }
}
async function browserRuntimePids(){
  const text=await cmd('/bin/ps',['-axo','pid=,command='],5_000);
  return text.split('\n').filter(line=>line.includes('--devos-browser-runtime')&&
      line.includes('/dist/src/cli.js')&&!line.includes('ps -axo'))
    .map(line=>line.trim().split(/\s+/)[0]!).sort();
}
async function gitHead(root:string){return cmd('/usr/bin/git',['-C',root,'rev-parse','HEAD']);}
async function gitClean(root:string){return (await cmd('/usr/bin/git',['-C',root,'status','--porcelain'])).length===0;}

export async function runProductionSafeChaos(productionRoot:string,sourceRoot:string){
  const prod=resolve(productionRoot),src=resolve(sourceRoot);
  const initial={owner:await owner(8787),staging:await owner(8788),
    health:await health(),head:await gitHead(prod),clean:await gitClean(prod),
    browserPids:await browserRuntimePids()};
  if(!initial.owner||initial.staging||!initial.health||!initial.clean||prod===src)
    throw new Error('Production baseline or checkout isolation unavailable');
  const args=['--test','tests/browser-chaos-stress.test.ts',
    'tests/chat-worker-grants.test.ts','tests/browser-recovery.test.ts',
    'tests/shared-browser-runtime.test.ts','tests/connector-auth-crash.test.ts',
    'tests/codex-executor.test.ts','tests/pipeline-diagnostics.test.ts'];
  const {stdout}=await exec('./node_modules/.bin/tsx',args,{cwd:src,
    timeout:150_000,maxBuffer:15*1024*1024});
  const tests=parseTestSummary(stdout);
  if(!validTestSummary(tests))throw new Error('Isolated chaos regression had failed/skipped tests');
  // Only ephemeral synthetic profiles are launched; NEVER the actual shared
  // user Camoufox profile or existing browser runtime. This is NOT a worker.
  const smoke=await exec('./node_modules/.bin/tsx',
    ['tests/shared-browser-runtime.smoke.ts'],{cwd:src,timeout:90_000,maxBuffer:1024*1024});
  const smokeRecord=JSON.parse(smoke.stdout.trim().split('\n').at(-1)!) as Record<string,unknown>;
  const hostSmoke=smokeRecord.runtimeProcessSurvivedControllerExit===true&&
    smokeRecord.sameBrowserRootAcrossControllers===true&&
    smokeRecord.ownedCleanupFallback===true&&smokeRecord.controlSurvived===true;
  const final={owner:await owner(8787),staging:await owner(8788),
    health:await health(),head:await gitHead(prod),clean:await gitClean(prod),
    browserPids:await browserRuntimePids()};
  return outcome({
    production_listener_unchanged:initial.owner===final.owner,
    production_health_200:final.health,
    staging_still_off:initial.staging===null&&final.staging===null,
    production_sha_unchanged:initial.head===final.head,
    production_checkout_clean:final.clean,
    active_worker_runtime_pids_unchanged:JSON.stringify(initial.browserPids)===JSON.stringify(final.browserPids),
    all_test_fixtures_pass:validTestSummary(tests),
  },tests,hostSmoke);
}

if(process.argv[1]?.endsWith('devos2-production-safe-chaos.smoke.ts')){
  if(process.argv.length!==4){
    console.error('Usage: tsx scripts/devos2-production-safe-chaos.smoke.ts <production-root> <isolated-worktree-root>');
    process.exitCode=2;
  }else runProductionSafeChaos(process.argv[2]!,process.argv[3]!)
    .then(result=>{console.log(JSON.stringify(result));if(result.status==='blocked')process.exitCode=2;})
    .catch(error=>{
      const message=String(error instanceof Error?error.message:error);
      const category=/timed?out/i.test(message)?'timeout':
        /browser|profile|camoufox/i.test(message)?'temporary_browser_fixture':
        'baseline_or_synthetic_regression';
      console.log(JSON.stringify({status:'blocked',category,
        scope:'isolated_production_safe_chaos_not_live_web_ios',
        productionRestarted:false,stagingStarted:false,
        independentlyVerifiedE2e:[]}));
      process.exitCode=2;
    });
}
