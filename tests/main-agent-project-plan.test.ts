import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp,mkdir,writeFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {createHash} from "node:crypto";
import {intakeDigest,type IntakeContract,type OwnerApprovalEvidence} from "../src/main-agent-intake.js";
import {prepareApprovedProjectPlan,publishApprovedIssue,projectGraphDigest,
  type MainAgentProjectPlan,type ProjectIssuePlan} from "../src/main-agent-project-plan.js";
import type {Workflow} from "../src/workflow.js";
import type {SpecKitArtifactContract} from "../src/spec-kit-contract.js";

const repo="EmporioBreak/DevOS";
const git=(root:string,...args:string[])=>execFileSync("git",["-C",root,...args],{encoding:"utf8"}).trim();
async function rootFixture(issues:number[],deps:Record<number,number[]>={}) {
  const root=await mkdtemp(join(tmpdir(),"devos-project-plan-"));
  git(root,"init","-q");
  const contracts=new Map<number,SpecKitArtifactContract>();
  for(const issue of issues) {
    const path="specs/"+issue+"-feature",references={spec:path+"/spec.md",plan:path+"/plan.md",tasks:path+"/tasks.md"};
    await mkdir(join(root,path),{recursive:true});
    for(const file of Object.values(references))
      await writeFile(join(root,file),"# Canonical original Spec Kit content for issue "+issue+"\n");
    contracts.set(issue,{version:1,task:{repo,issue},epic:121,scenario:"feature",
      phase:"approved",commit:"0".repeat(40),artifactDirectory:path,
      artifacts:references,dependsOn:deps[issue]??[]});
  }
  git(root,"add",".");
  git(root,"-c","user.name=Fixtures","-c","user.email=fixtures@example.invalid",
    "commit","-qm","Synthetic canonical artifacts for project plan");
  const sha=git(root,"rev-parse","HEAD");
  for(const c of contracts.values()) c.commit=sha;
  return {root,contracts};
}
function graph(issue:number,pr?:number):Workflow {
  return {version:1,task:{repo,issue,...(pr?{pr}:{})},
    owner:{mode:"main_agent"},start:"developer",
    workers:[
      {id:"developer",executor:"chatgpt_browser",prompt:"Implement only approved scope",
       on:{done:"reviewer",needs_local_worker:"local_developer",failed:null}},
      {id:"local_developer",executor:"codex",prompt:"Fallback only after concrete blocker",
       on:{done:"reviewer",failed:null}},
      {id:"reviewer",executor:"chatgpt_browser",prompt:"Independently review linked PR",
       on:{approved:null,changes_requested:"developer",failed:null}},
    ]};
}
function issue(artifact:SpecKitArtifactContract,dependsOn:string[]=[],key="issue-"+artifact.task.issue,
  kind:"architectural"|"bounded"="architectural"):ProjectIssuePlan {
  const task=artifact.task.issue;
  const intent:IntakeContract={version:1,scenario:"feature",size:kind,
    userGoal:"Deliver an independently usable product module "+task,
    userScenarios:["User can complete the module workflow "+task],
    scope:["Implement subsystem "+task],
    nonGoals:["No other modules beyond "+task],
    acceptance:["Subsystem "+task+" passes independent acceptance"],
    options:[{id:"first",benefits:"Simple",risks:"Less portable"},
      {id:"second",benefits:"Portable",risks:"Extra integration"}],
    selectedOption:"first",artifacts:artifact};
  const ready:ProjectIssuePlan={key,issue:task,title:"Subsystem "+task,
    intent,ownerEvidence:[],graphApproval:{kind:"plan",userMessageRef:"verified-host-event",
      reviewedDigest:"0".repeat(64)},dependsOn,workflow:graph(task)};
  ready.ownerEvidence=(kind==="architectural"?["scope","spec","plan"]:["scope"])
    .map(k=>({kind:k as "scope"|"spec"|"plan",userMessageRef:"verified-host-event",
      reviewedDigest:intakeDigest(intent)}));
  ready.graphApproval.reviewedDigest=projectGraphDigest(ready,121);
  return ready;
}
const verifier=async(e:OwnerApprovalEvidence,expected:{kind:"scope"|"spec"|"plan";digest:string})=>
  e.userMessageRef==="verified-host-event" && e.kind===expected.kind &&
  e.reviewedDigest===expected.digest;
const plan=(plans:ProjectIssuePlan[]):MainAgentProjectPlan=>({
  version:1,repo,epic:121,issues:plans,
});

test("large product expands into three independently verifiable Issues with DAG, not T001 micro-Issues",async()=>{
  const {root,contracts}=await rootFixture([501,502,503],{501:[],502:[501],503:[502]});
  try {
    const project=plan([issue(contracts.get(503)!,["issue-502"]),
      issue(contracts.get(501)!),issue(contracts.get(502)!,["issue-501"])]);
    const result=await prepareApprovedProjectPlan(project,{projectRoot:root,verifyApproval:verifier});
    assert.deepEqual(result.ordering,[501,502,503]);
    assert.equal(result.issues.length,3);
    assert.deepEqual(result.issues.map(x=>x.dependsOn),[[],[501],[502]]);
    for(const item of result.issues){
      assert.match(item.body,/DEVOS_SPECKIT_V1/);
      assert.match(item.body,/DEVOS_MAIN_AGENT_PLAN_V1/);
      assert.match(item.body,/### Acceptance criteria/);
      assert.match(item.body,/### Non-goals/);
      assert.match(item.body,/Exact original Spec Kit commit/);
      assert.doesNotMatch(item.body,/T001.*GitHub Issue|docs\/superpowers\/plans/);
    }
    assert.match(result.fingerprint,/^[a-f0-9]{64}$/);
  } finally {await rm(root,{recursive:true,force:true})}
});

test("small approved adjustment creates one Issue with internal Spec Kit tasks, not one Issue per step",async()=>{
  const {root,contracts}=await rootFixture([520]);
  try{
    const small=issue(contracts.get(520)!,[],"small-ui","bounded");
    const result=await prepareApprovedProjectPlan(plan([small]),{projectRoot:root,verifyApproval:verifier});
    assert.deepEqual(result.ordering,[520]);
    assert.equal(result.issues.length,1);
    assert.match(result.issues[0]!.body,/specs\/520-feature\/tasks.md/);
  } finally{await rm(root,{recursive:true,force:true})}
});

test("no fake human consent, and no changed scope or worker graph after signoff",async()=>{
  const {root,contracts}=await rootFixture([531]);
  try{
    const proposed=issue(contracts.get(531)!);
    await assert.rejects(prepareApprovedProjectPlan(plan([proposed]),{
      projectRoot:root,verifyApproval:async()=>false}),/not owner-approved/);
    const changed=structuredClone(proposed);
    changed.workflow.workers.push({
      id:"extra_agent",executor:"chatgpt_browser",prompt:"Newly invented agent",
      on:{done:null}});
    await assert.rejects(prepareApprovedProjectPlan(plan([changed]),{
      projectRoot:root,verifyApproval:verifier}),/(?:full worker graph|unreachable worker)/);
    const diff=structuredClone(proposed);
    diff.intent.scope=["Entirely new feature not previously authorized"];
    await assert.rejects(prepareApprovedProjectPlan(plan([diff]),{
      projectRoot:root,verifyApproval:verifier}),/not owner-approved/);
    const fake=structuredClone(proposed);
    fake.graphApproval.userMessageRef="tool-supplied-lie";
    await assert.rejects(prepareApprovedProjectPlan(plan([fake]),{
      projectRoot:root,verifyApproval:verifier}),/(?:full worker graph|unreachable worker)/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("rejects cycles, wrong dependencies, spoofed PR and unauthorized graph changes",async()=>{
  const {root,contracts}=await rootFixture([541,542],{541:[542],542:[541]});
  try{
    const a=issue(contracts.get(541)!,["issue-542"]);
    const b=issue(contracts.get(542)!,["issue-541"]);
    await assert.rejects(prepareApprovedProjectPlan(plan([a,b]),{
      projectRoot:root,verifyApproval:verifier}),/Cyclic/);
    await assert.rejects(prepareApprovedProjectPlan(plan([a,a]),{
      projectRoot:root,verifyApproval:verifier}),/Duplicate Main Agent/);
    const wrong=structuredClone(a);
    wrong.dependsOn=[];
    await assert.rejects(prepareApprovedProjectPlan(plan([wrong]),{
      projectRoot:root,verifyApproval:verifier}),/dependencies require reapproved/);
    const independent=issue({...contracts.get(541)!,dependsOn:[]});
    const spoof=structuredClone(independent);
    spoof.linkedPr=90;
    await assert.rejects(prepareApprovedProjectPlan(plan([spoof]),{
      projectRoot:root,verifyApproval:verifier}),/linked PR differs/);
    const skip=structuredClone(independent);
    skip.workflow.start="local_developer";
    await assert.rejects(prepareApprovedProjectPlan(plan([skip]),{
      projectRoot:root,verifyApproval:verifier}),/(?:full worker graph|unreachable worker)/);
    const noReviewer=structuredClone(independent);
    noReviewer.workflow.workers=noReviewer.workflow.workers.filter(x=>x.id!=="reviewer");
    noReviewer.workflow.workers[0]!.on.done=null;
    noReviewer.workflow.workers[1]!.on.done=null;
    await assert.rejects(prepareApprovedProjectPlan(plan([noReviewer]),{
      projectRoot:root,verifyApproval:verifier}),/independent reviewer/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Main Agent GitHub publisher preserves existing Issue text, CAS checks and idempotency",async()=>{
  const {root,contracts}=await rootFixture([551]);
  try {
    const requested=plan([issue(contracts.get(551)!)]);
    let body="Existing user's issue notes, never overwrite.",updateCount=0;
    const provider={
      async readIssue(_repo:string,number:number){
        return {number,title:"Reserved issue",body,state:"open" as const};
      },
      async verifyLinkedPr(_repo:string,_issue:number,_pr:number){return true;},
      async updateIssue(_repo:string,_number:number,value:string,expected:string){
        if(createHash("sha256").update(JSON.stringify(body)).digest("hex")!==expected)
          throw new Error("GitHub conditional write rejected stale revision");
        body=value;updateCount++;
      },
    };
    const fingerprint=createHash("sha256").update(JSON.stringify(body)).digest("hex");
    assert.equal(await publishApprovedIssue(requested,551,fingerprint,provider,
      {projectRoot:root,verifyApproval:verifier}),"published");
    assert.match(body,/Existing user's issue notes/);
    assert.match(body,/DEVOS_SPECKIT_V1/);
    assert.equal(await publishApprovedIssue(requested,551,fingerprint,provider,
      {projectRoot:root,verifyApproval:verifier}),"already_published");
    assert.equal(updateCount,1);
    const changed=body+"\nAnother human comment";
    body=changed;
    const same=createHash("sha256").update(JSON.stringify("Existing user's issue notes, never overwrite.")).digest("hex");
    assert.equal(await publishApprovedIssue(requested,551,same,provider,
      {projectRoot:root,verifyApproval:verifier}),"already_published");
    body="Human revision before publication";
    await assert.rejects(publishApprovedIssue(requested,551,fingerprint,provider,
      {projectRoot:root,verifyApproval:verifier}),/changed concurrently/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("reject worker report URL with token, invented external issue or secrets",async()=>{
  const {root,contracts}=await rootFixture([561]);
  try{
    const x=issue(contracts.get(561)!);
    x.workerReports=["https://github.com/EmporioBreak/DevOS/issues/561?token=secret"];
    await assert.rejects(prepareApprovedProjectPlan(plan([x]),{
      projectRoot:root,verifyApproval:verifier}),/same-repository GitHub URLs/);
    x.workerReports=["https://github.com/EmporioBreak/DevOS/issues/561#issuecomment-15"];
    x.graphApproval.reviewedDigest=projectGraphDigest(x,121);
    const result=await prepareApprovedProjectPlan(plan([x]),{
      projectRoot:root,verifyApproval:verifier});
    assert.match(result.issues[0]!.body,/issuecomment-15/);
  }finally{await rm(root,{recursive:true,force:true})}
});


test("GitHub publisher rejects fabricated approvals, unverified linked PR and changed human text",async()=>{
  const {root,contracts}=await rootFixture([571]);
  try {
    const real=issue(contracts.get(571)!);
    real.linkedPr=91;
    real.workflow.task.pr=91;
    real.graphApproval.reviewedDigest=projectGraphDigest(real,121);
    const request=plan([real]);
    let body="Existing reserved Issue";let writes=0;
    const provider={
      async readIssue(_repo:string,number:number){
        return {number,title:"Reserved",body,state:"open" as const};
      },
      async verifyLinkedPr(_repo:string,_issue:number,_pr:number){return false;},
      async updateIssue(_repo:string,_issue:number,newBody:string){
        writes++;body=newBody;
      },
    };
    const expected=createHash("sha256").update(JSON.stringify(body)).digest("hex");
    await assert.rejects(publishApprovedIssue(request,571,expected,provider,{
      projectRoot:root,verifyApproval:async()=>false,
    }),/not owner-approved/);
    await assert.rejects(publishApprovedIssue(request,571,expected,provider,{
      projectRoot:root,verifyApproval:verifier,
    }),/Linked PR not independently confirmed/);
    assert.equal(writes,0);
    const bad=structuredClone(request);
    bad.issues[0]!.workflow.workers.push({
      id:"invented",executor:"chatgpt_browser",prompt:"Surprise role",on:{done:null},
    });
    await assert.rejects(publishApprovedIssue(bad,571,expected,provider,{
      projectRoot:root,verifyApproval:verifier,
    }),/(?:full worker graph|unreachable worker)/);
    assert.equal(writes,0);
  } finally {await rm(root,{recursive:true,force:true})}
});


test("Main Agent owner-signed review-only project graph may start with local Codex",async()=>{
  const {root,contracts}=await rootFixture([591]);
  try{
    const p=issue(contracts.get(591)!,[],"postmerge-review-591");
    p.workflow.start="local_reviewer";
    p.workflow.workers=[{id:"local_reviewer",executor:"codex",
      prompt:"Independently review the merged PR; no implementation",
      on:{approved:null,changes_requested:null,failed:null}}];
    p.graphApproval.reviewedDigest=projectGraphDigest(p,121);
    const approved=await prepareApprovedProjectPlan(plan([p]),{
      projectRoot:root,verifyApproval:verifier});
    assert.deepEqual(approved.ordering,[591]);
    assert.match(approved.issues[0]!.workerGraphDigest,/^[0-9a-f]{64}$/);
    const spoof=structuredClone(p);
    spoof.workflow.workers[0]!.prompt="Unapproved changed instructions";
    await assert.rejects(prepareApprovedProjectPlan(plan([spoof]),{
      projectRoot:root,verifyApproval:verifier}),/(?:full worker graph|unreachable worker)/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Main Agent signs planned browser done to local Codex, not fake host escalation",async()=>{
  const {root,contracts}=await rootFixture([592]);
  try{
    const p=issue(contracts.get(592)!,[],"capability-plan-592");
    p.workflow.workers[0]!.on={done:"local_developer",failed:null};
    p.graphApproval.reviewedDigest=projectGraphDigest(p,121);
    const result=await prepareApprovedProjectPlan(plan([p]),{
      projectRoot:root,verifyApproval:verifier});
    assert.deepEqual(result.ordering,[592]);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Main Agent rejects unreachable extra workers even if their IDs are listed",async()=>{
  const {root,contracts}=await rootFixture([593]);
  try{
    const p=issue(contracts.get(593)!,[],"orphan-worker-593");
    p.workflow.workers[0]!.on={done:"reviewer",failed:null};
    assert.throws(()=>projectGraphDigest(p),/unreachable worker/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("visual user acceptance cannot be delegated to shell-only evidence or an unverifiable executor",async()=>{
  const {root,contracts}=await rootFixture([594]);
  try{
    const p=issue(contracts.get(594)!,[],"visual-acceptance-594");
    p.intent.acceptance=["Observe rendered desktop and click through the real login flow"];
    p.workerActions=[{id:"visually-check-login",acceptanceIndex:0,workerId:"developer",capability:"visual_desktop_test"}];
    p.ownerEvidence=[{kind:"scope",userMessageRef:"verified-host-event",reviewedDigest:intakeDigest(p.intent)},
      {kind:"spec",userMessageRef:"verified-host-event",reviewedDigest:intakeDigest(p.intent)},
      {kind:"plan",userMessageRef:"verified-host-event",reviewedDigest:intakeDigest(p.intent)}];
    p.graphApproval.reviewedDigest=projectGraphDigest(p,121);
    await assert.rejects(prepareApprovedProjectPlan(plan([p]),{projectRoot:root,verifyApproval:verifier}),
      /capability|visual|verifier/i,"no independent host proof must fail closed");
    const shellOnly=async()=>({task:{repo,issue:594},workerId:"developer",actionId:"visually-check-login",
      executor:"chatgpt_browser" as const,observed:["shell_command"],sessionBound:true});
    await assert.rejects(prepareApprovedProjectPlan(plan([p]),{
      projectRoot:root,verifyApproval:verifier,verifyWorkerAction:shellOnly,
    }),/capability|visual/i,"executing shell/Playwright is not a visible human-style desktop interaction");
    const actuallyVerified=async()=>({task:{repo,issue:594},workerId:"developer",actionId:"visually-check-login",
      executor:"chatgpt_browser" as const,observed:["visual_screen","visual_pointer"],sessionBound:true});
    const ready=await prepareApprovedProjectPlan(plan([p]),{
      projectRoot:root,verifyApproval:verifier,verifyWorkerAction:actuallyVerified,
    });
    assert.match(ready.issues[0]!.body,/visually-check-login/);
    const changed=structuredClone(p);
    changed.workerActions![0]!.capability="scripted_ui_test";
    await assert.rejects(prepareApprovedProjectPlan(plan([changed]),{
      projectRoot:root,verifyApproval:verifier,verifyWorkerAction:actuallyVerified,
    }),/full worker graph/i,"changing evidence strength invalidates exact owner-approved plan digest");
  }finally{await rm(root,{recursive:true,force:true})}
});

test("iOS visual action needs screen plus actual native taps, not simctl or shell",async()=>{
  const {root,contracts}=await rootFixture([595]);
  try{
    const p=issue(contracts.get(595)!,[],"ios-visual-595");
    p.workerActions=[{id:"tap-settings",acceptanceIndex:0,workerId:"local_developer",capability:"ios_simulator_visual_test"}];
    p.graphApproval.reviewedDigest=projectGraphDigest(p,121);
    for(const observed of [["shell_command"],["ios_screen"],["ios_tap"],["visual_screen","visual_pointer"]]){
      await assert.rejects(prepareApprovedProjectPlan(plan([p]),{
        projectRoot:root,verifyApproval:verifier,
        verifyWorkerAction:async()=>({task:{repo,issue:595},workerId:"local_developer",
          actionId:"tap-settings",executor:"codex",observed,sessionBound:true}),
      }),/capability|ios/i);
    }
    const verified=await prepareApprovedProjectPlan(plan([p]),{
      projectRoot:root,verifyApproval:verifier,
      verifyWorkerAction:async()=>({task:{repo,issue:595},workerId:"local_developer",
        actionId:"tap-settings",executor:"codex",observed:["ios_screen","ios_tap"],sessionBound:true}),
    });
    assert.equal(verified.issues.length,1);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("worker action proof is exact-task, worker, executor and session bound",async()=>{
  const {root,contracts}=await rootFixture([596]);
  try{
    const p=issue(contracts.get(596)!,[],"host-identity-596");
    p.workerActions=[{id:"desktop-flow",acceptanceIndex:0,workerId:"reviewer",capability:"visual_desktop_test"}];
    p.graphApproval.reviewedDigest=projectGraphDigest(p,121);
    const proof={task:{repo,issue:596},workerId:"reviewer",actionId:"desktop-flow",
      executor:"chatgpt_browser" as const,observed:["visual_screen","visual_pointer"],sessionBound:true};
    const args={projectRoot:root,verifyApproval:verifier};
    const bad=[
      {...proof,task:{repo,issue:597}},
      {...proof,workerId:"developer"},
      {...proof,actionId:"unrelated-flow"},
      {...proof,executor:"codex" as const},
      {...proof,sessionBound:false},
      {...proof,observed:["visual_screen","shell_command"]},
    ];
    for(const counterfeit of bad){
      await assert.rejects(prepareApprovedProjectPlan(plan([p]),{
        ...args,verifyWorkerAction:async()=>counterfeit,
      }),/Required worker capability not independently proven/);
    }
    const good=await prepareApprovedProjectPlan(plan([p]),{
      ...args,verifyWorkerAction:async()=>proof,
    });
    assert.match(good.issues[0]!.body,/Independently verified worker action capabilities/);
    const malformed=structuredClone(p);
    malformed.workerActions!.push({...malformed.workerActions![0]!});
    assert.throws(()=>projectGraphDigest(malformed),/duplicated Main Agent worker capability/i);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("capability modality is independent of named role and chosen executor",async()=>{
  const {root,contracts}=await rootFixture([597]);
  try{
    const p=issue(contracts.get(597)!,[],"capability-executor-597");
    p.workerActions=[{id:"native-desktop-inspection",acceptanceIndex:0,
      workerId:"local_developer",capability:"visual_desktop_test"}];
    p.graphApproval.reviewedDigest=projectGraphDigest(p,121);
    const r=await prepareApprovedProjectPlan(plan([p]),{
      projectRoot:root,verifyApproval:verifier,
      verifyWorkerAction:async()=>({task:{repo,issue:597},workerId:"local_developer",
        actionId:"native-desktop-inspection",executor:"codex",
        observed:["visual_screen","visual_pointer"],sessionBound:true}),
    });
    assert.match(r.issues[0]!.body,/native-desktop-inspection.*local_developer.*codex/);
    const impossible=structuredClone(p);
    impossible.workerActions![0]!.workerId="unplanned_agent";
    assert.throws(()=>projectGraphDigest(impossible),/worker capability assignment/i);
  }finally{await rm(root,{recursive:true,force:true})}
});
