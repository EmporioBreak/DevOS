import assert from "node:assert/strict";
import test from "node:test";
import {readFile,writeFile,mkdtemp,mkdir,cp,rm} from "node:fs/promises";
import {tmpdir,homedir} from "node:os";
import {join} from "node:path";
import {resolveWorkerSkills,saveWorkerSkillManifest} from "../src/skill-policy.js";
import {sealRunnerSkillGraph,verifyRunnerSkillGraph} from "../src/runner-skill-graph.js";
import {Orchestrator,type RunState,type StateStore} from "../src/orchestrator.js";
import type {Executor,WorkerRequest} from "../src/executor.js";
import type {WorkerOutput,Workflow} from "../src/workflow.js";
import {parseWorkflow} from "../src/workflow-loader.js";

const secret="strong-test-owner-key-".repeat(3);
const upstreamRoot=join(homedir(),".devos-staging","upstream");
const definitions={
  library:JSON.parse(await readFile("config/devos-skills.json","utf8")),
  qualityPolicy:JSON.parse(await readFile("config/devos-quality-methods.json","utf8")),
  stagePins:JSON.parse(await readFile("config/devos-speckit-stage-pins.json","utf8")),
  roots:{projectRoot:process.cwd(),upstreamRoot,
    upstreamPins:{superpowers:"8ca22dba9a94f28898bbce59f2537ff4d87c747d"}},
};
function workflow():Workflow{
  return {version:1,task:{repo:"EmporioBreak/DevOS",issue:744,pr:917},
    owner:{mode:"main_agent"},skillsMode:"strict",start:"developer",
    workers:[
      {id:"developer",executor:"chatgpt_browser",prompt:"Implement exact frozen task",
        on:{done:"reviewer",needs_local_worker:"host",failed:null}},
      {id:"host",executor:"codex",prompt:"Fallback after browser environment blocker",
        on:{done:"reviewer",failed:null}},
      {id:"reviewer",executor:"chatgpt_browser",prompt:"Review, not self approve",
        on:{changes_requested:"developer",approved:null,failed:null}},
    ]};
}
async function fixture(opts:{missing?:string;approve?:boolean}={}){
  const root=await mkdtemp(join(tmpdir(),"devos-runner-skills-"));
  await mkdir(join(root,"config"),{recursive:true});
  for(const file of ["devos-skills.json","devos-skill-policy.json",
    "devos-quality-methods.json","devos-speckit-stage-pins.json",
    "devos-upstreams.lock.json"])
    await cp(join("config",file),join(root,"config",file));
  await mkdir(join(root,".agents","skills","speckit-implement"),{recursive:true});
  await cp(".agents/skills/speckit-implement/SKILL.md",
    join(root,".agents","skills","speckit-implement","SKILL.md"));
  const w=workflow();
  for(const entry of w.workers) {
    if(entry.id===opts.missing)continue;
    const role=entry.id==="reviewer"?"reviewer":"developer";
    const stage=entry.id==="reviewer"?null:"implement";
    const manifest=await resolveWorkerSkills({
      repo:w.task.repo,issue:w.task.issue,workerId:entry.id,role,
      phase:"execution",specKitStage:stage,
      optionalCandidates:role==="developer"?[
        "superpowers-test-driven-development",
      ]:[],
    },{version:1,rules:[]},definitions);
    await saveWorkerSkillManifest(root,manifest,secret);
  }
  return {root,w};
}
class FakeStore implements StateStore{
  state:RunState|null=null;
  async load(){return this.state;}
  async save(s:RunState){this.state=s;}
  async clear(){this.state=null;}
}
class BrowserFake implements Executor{
  kind="chatgpt_browser" as const;
  requests:WorkerRequest[]=[];
  async run(request:WorkerRequest):Promise<WorkerOutput>{
    this.requests.push(request);
    return {text:request.workerId==="reviewer"?
      'DEVOS_RESULT {"status":"approved"}':'DEVOS_RESULT {"status":"done"}',
      sessionId:"https://chatgpt.com/c/"+request.workerId};
  }
}
test("strict graph verifies all signed skills once and again per declared worker, then hands off",async()=>{
  const f=await fixture();
  try{
    const sha=await sealRunnerSkillGraph(f.root,f.w,secret,async()=>true,upstreamRoot);
    assert.match(sha,/^[a-f0-9]{64}$/);
    const manifest=await verifyRunnerSkillGraph(f.root,f.w,secret,upstreamRoot);
    assert.equal(manifest.workers.length,3);
    assert.equal(manifest.workers.find(x=>x.workerId==="developer")!.stage,"implement");
    assert.equal(manifest.workers.find(x=>x.workerId==="reviewer")!.stage,null);
    const fake=new BrowserFake();
    const state=await new Orchestrator({
      projectRoot:f.root,workflow:f.w,executors:new Map([["chatgpt_browser",fake]]),
      stateStore:new FakeStore(),
      verifyAssignedWorkerSkills:async id=>{
        const verified=await verifyRunnerSkillGraph(f.root,f.w,secret,upstreamRoot);
        const w=verified.workers.find(x=>x.workerId===id);
        assert.ok(w,"unknown worker cannot spawn");
        return {stage:w.stage,manifestSha256:w.manifestSha256};
      },
    }).run();
    assert.equal(state.completedRuns,2);
    assert.equal(state.mainAgentReviewPending,true);
    assert.deepEqual(fake.requests.map(x=>x.workerId),["developer","reviewer"]);
    assert.match(fake.requests[0]!.prompt,/STRICT assigned skill manifest/);
    assert.match(fake.requests[0]!.prompt,/devos_skill_manifest/);
    assert.match(fake.requests[0]!.prompt,/Original Spec Kit stage: implement/);
    assert.match(fake.requests[1]!.prompt,/Original Spec Kit stage: none/);
    assert.equal(fake.requests[0]!.codexSkills,undefined);
  }finally{await rm(f.root,{recursive:true,force:true})}
});
test("missing signed worker allocation and missing user approval fail before sealing",async()=>{
  const f=await fixture({missing:"reviewer"});
  try{
    await assert.rejects(sealRunnerSkillGraph(f.root,f.w,secret,async()=>false,upstreamRoot),
      /Missing verified owner approval/);
    await assert.rejects(sealRunnerSkillGraph(f.root,f.w,secret,async()=>true,upstreamRoot),
      /ENOENT/);
    await assert.rejects(verifyRunnerSkillGraph(f.root,f.w,secret,upstreamRoot),/ENOENT/);
  }finally{await rm(f.root,{recursive:true,force:true})}
});
test("frozen workflow cannot mutate prompts, PR, worker graph or signed skills",async()=>{
  const f=await fixture();
  try{
    await sealRunnerSkillGraph(f.root,f.w,secret,async()=>true,upstreamRoot);
    for(const edited of [
      {...f.w,task:{...f.w.task,pr:932}},
      {...f.w,workers:f.w.workers.map((w,i)=>i? w : {...w,prompt:"Silently widen scope"})},
      {...f.w,workers:[...f.w.workers,{
        id:"invented",executor:"chatgpt_browser" as const,prompt:"New agent",on:{done:null},
      }]},
    ]) {
      await assert.rejects(verifyRunnerSkillGraph(f.root,edited,secret,upstreamRoot),
        /graph does not match/);
    }
    await assert.rejects(verifyRunnerSkillGraph(f.root,f.w,
      "different-long-enough-owner-key-secret-123",upstreamRoot),/HMAC/);
    const assignment=join(f.root,".devos","skills","assignments",
      "EmporioBreak%2FDevOS","744","developer.json");
    const raw=JSON.parse(await readFile(assignment,"utf8"));
    raw.manifest.role="reviewer";
    await writeFile(assignment,JSON.stringify(raw));
    await assert.rejects(verifyRunnerSkillGraph(f.root,f.w,secret,upstreamRoot),
      /MAC integrity/);
  }finally{await rm(f.root,{recursive:true,force:true})}
});
test("strict Orchestrator refuses unsigned runtime callback without starting browser worker",async()=>{
  const f=await fixture();
  try{
    const fake=new BrowserFake();
    await assert.rejects(new Orchestrator({projectRoot:f.root,
      workflow:f.w,executors:new Map([["chatgpt_browser",fake]]),
      stateStore:new FakeStore()}).run(),
      /Strict Runner requires verified frozen worker assignments/);
    assert.equal(fake.requests.length,0);
  }finally{await rm(f.root,{recursive:true,force:true})}
});
test("legacy workflow stays compatible, and unsupported skills mode is rejected",()=>{
  const w=workflow();
  const legacy={...w,skillsMode:undefined};
  assert.equal(parseWorkflow(legacy).skillsMode,undefined);
  assert.equal(parseWorkflow(w).skillsMode,"strict");
  assert.throws(()=>parseWorkflow({...w,skillsMode:"override"}),/Unsupported Runner skills mode/);
});


test("strict browser to Codex fallback preserves signed assignment, original Issue and reviewer",async()=>{
  const f=await fixture();
  try{
    await sealRunnerSkillGraph(f.root,f.w,secret,async()=>true,upstreamRoot);
    const requests:WorkerRequest[]=[];
    const browser:Executor={kind:"chatgpt_browser",async run(request){
      requests.push(request);
      return {text:request.workerId==="reviewer"?
        'DEVOS_RESULT {"status":"approved"}':
        'DEVOS_RESULT {"status":"needs_local_worker"}',
        sessionId:"https://chatgpt.com/c/"+request.workerId};
    }};
    const codex:Executor={kind:"codex",async run(request){
      requests.push(request);
      assert.equal(request.codexSkills?.mandatory,true);
      assert.deepEqual(request.codexSkills?.task,f.w.task);
      assert.equal(request.codexSkills?.workerId,"host");
      return {text:'DEVOS_RESULT {"status":"done"}',sessionId:"local-codex-thread-744"};
    }};
    const state=await new Orchestrator({projectRoot:f.root,workflow:f.w,
      executors:new Map([["chatgpt_browser",browser],["codex",codex]]),
      stateStore:new FakeStore(),verifyAssignedWorkerSkills:async (workerId:string)=>{
        const stage=await verifyRunnerSkillGraph(f.root,f.w,secret,upstreamRoot);
        const ref=stage.workers.find(x=>x.workerId===workerId)!;
        return {stage:ref.stage,manifestSha256:ref.manifestSha256};
      }}).run();
    assert.deepEqual(requests.map(x=>x.workerId),["developer","host","reviewer"]);
    assert.equal(state.completedRuns,3);
    assert.equal(state.mainAgentReviewPending,true);
    assert.equal(state.task?.pr,917);
    assert.equal(state.sessions.host,"local-codex-thread-744");
  }finally{await rm(f.root,{recursive:true,force:true})}
});
test("strict verification must precede Camoufox process startup",async()=>{
  const f=await fixture();
  const {runWorkflow,cliBrowserRuntimeDeps}=await import("../src/cli.js");
  const original=cliBrowserRuntimeDeps.ensure;
  let started=false;
  cliBrowserRuntimeDeps.ensure=async (...args)=>{
    started=true;return original(...args);
  };
  const previous=process.env.DEVOS_CONNECTOR_OWNER_SECRET;
  process.env.DEVOS_CONNECTOR_OWNER_SECRET=secret;
  try{
    await assert.rejects(runWorkflow(f.w,"run",f.root),/ENOENT/);
    assert.equal(started,false);
  }finally{
    cliBrowserRuntimeDeps.ensure=original;
    if(previous===undefined)delete process.env.DEVOS_CONNECTOR_OWNER_SECRET;
    else process.env.DEVOS_CONNECTOR_OWNER_SECRET=previous;
    await rm(f.root,{recursive:true,force:true});
  }
});

test("strict review loop reuses exact browser chats and task PR across requested corrections",async()=>{
  const f=await fixture();
  try{
    await sealRunnerSkillGraph(f.root,f.w,secret,async()=>true,upstreamRoot);
    const calls:WorkerRequest[]=[];
    let reviewCount=0;
    const chat:Executor={kind:"chatgpt_browser",async run(request){
      calls.push(request);
      const url="https://chatgpt.com/g/g-project/c/"+request.workerId+"-744";
      if(request.workerId==="reviewer")reviewCount++;
      return {text:'DEVOS_RESULT {"status":"'+
        (request.workerId==="reviewer" && reviewCount===1?"changes_requested":
        request.workerId==="reviewer"?"approved":"done")+'"}',
        sessionId:url};
    }};
    const store=new FakeStore();
    const actual=await new Orchestrator({projectRoot:f.root,
      workflow:f.w,executors:new Map([["chatgpt_browser",chat]]),
      stateStore:store,verifyAssignedWorkerSkills:async (workerId:string)=>{
        const result=await verifyRunnerSkillGraph(f.root,f.w,secret,upstreamRoot);
        const p=result.workers.find(w=>w.workerId===workerId)!;
        return {stage:p.stage,manifestSha256:p.manifestSha256};
      }}).run();
    assert.deepEqual(calls.map(x=>x.workerId),
      ["developer","reviewer","developer","reviewer"]);
    assert.equal(actual.completedRuns,4);
    assert.equal(actual.mainAgentReviewPending,true);
    assert.equal(actual.task?.pr,917);
    assert.equal(calls[2]?.sessionId,"https://chatgpt.com/g/g-project/c/developer-744");
    assert.equal(calls[3]?.sessionId,"https://chatgpt.com/g/g-project/c/reviewer-744");
    assert.notEqual(calls[0]?.browserTurnId,calls[2]?.browserTurnId);
    assert.equal(actual.sessions.developer,"https://chatgpt.com/g/g-project/c/developer-744");
    assert.equal(actual.sessions.reviewer,"https://chatgpt.com/g/g-project/c/reviewer-744");
  }finally{await rm(f.root,{recursive:true,force:true})}
});
test("strict ambiguous browser result cannot replay an already submitted turn",async()=>{
  const f=await fixture();
  try{
    await sealRunnerSkillGraph(f.root,f.w,secret,async()=>true,upstreamRoot);
    const store=new FakeStore();
    let sends=0;
    const chat:Executor={kind:"chatgpt_browser",async run(request){
      sends++;
      const url="https://chatgpt.com/g/g-project/c/confirmed-744";
      await request.onSession?.(url);
      return {text:"ambiguous post-submit terminal output",sessionId:url};
    }};
    const config={projectRoot:f.root,workflow:f.w,
      executors:new Map([["chatgpt_browser",chat]]),
      stateStore:store,
      verifyAssignedWorkerSkills:async (workerId:string)=>{
        const graph=await verifyRunnerSkillGraph(f.root,f.w,secret,upstreamRoot);
        const found=graph.workers.find(x=>x.workerId===workerId)!;
        return {stage:found.stage,manifestSha256:found.manifestSha256};
      }};
    await assert.rejects(new Orchestrator(config).run(),/DEVOS_RESULT/);
    assert.equal(sends,1);
    assert.equal(store.state?.sessions.developer,
      "https://chatgpt.com/g/g-project/c/confirmed-744");
    await assert.rejects(new Orchestrator(config).run(),/Unresolved prior browser turn/);
    assert.equal(sends,1,"may-have-submitted must NOT replay unsafe browser operation");
  }finally{await rm(f.root,{recursive:true,force:true})}
});
