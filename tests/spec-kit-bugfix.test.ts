import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync,spawnSync} from "node:child_process";
import {intakeDigest,type IntakeContract,type OwnerApprovalEvidence} from "../src/main-agent-intake.js";
import {assessBugfixReadiness,type BugfixFixEvidence,type BugfixCheck} from "../src/spec-kit-bugfix.js";
import type {OriginalScenarioStageEvidence} from "../src/spec-kit-scenarios.js";
import {verifyOriginalScenarioCommand} from "../src/spec-kit-scenarios.js";

const git=(root:string,...args:string[])=>execFileSync("git",["-C",root,...args],{encoding:"utf8"}).trim();
const origin={repo:"EmporioBreak/DevOS",issue:731};
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"devos-bugfix-fixture-"));
  git(root,"init","-q");
  await mkdir(join(root,"config"),{recursive:true});
  await writeFile(join(root,"config","devos-upstreams.lock.json"),
    await readFile("config/devos-upstreams.lock.json"));
  const folder=".specify/bugs/callback-token";
  await mkdir(join(root,folder),{recursive:true});
  await writeFile(join(root,"app.mjs"),
    "export function callback(payload){return payload.token.value}\n");
  await writeFile(join(root,"repro.mjs"),
    'import {callback} from "./app.mjs";if(callback({})!==null)throw Error("Incorrect result");\n');
  await writeFile(join(root,"regression.mjs"),
    'import {callback} from "./app.mjs";if(callback({token:{value:"ok"}})!=="ok")throw Error("Valid callback broken");if(callback({})!==null)throw Error("Missing token not handled");\n');
  const before=spawnSync("node",["repro.mjs"],{cwd:root,encoding:"utf8"});
  assert.notEqual(before.status,0,"bug must reproduce before implementing");
  await writeFile(join(root,"app.mjs"),
    "export function callback(payload){return payload?.token?.value??null}\n");
  const reproduced=spawnSync("node",["repro.mjs"],{cwd:root,encoding:"utf8"});
  const regression=spawnSync("node",["regression.mjs"],{cwd:root,encoding:"utf8"});
  assert.equal(reproduced.status,0);
  assert.equal(regression.status,0);
  const paths={assessment:folder+"/assessment.md",fix:folder+"/fix.md",
    test:folder+"/test.md"};
  await writeFile(join(root,paths.assessment),
    "# Bug assessment\nOriginal symptom: TypeError on missing token.\n"+
    "Reproducer: node repro.mjs fails on unpatched implementation.\n"+
    "Root cause: dereferencing an absent token without a guard.\n");
  await writeFile(join(root,paths.fix),
    "# Bug fix\nApproved scope: app.mjs only.\n"+
    "Minimal fix: optional chain and null fallback; add repro and regression tests.\n");
  await writeFile(join(root,paths.test),
    "# Verification\nOriginal reproducer re-run: passed.\n"+
    "Regression check: passed. No skipped tests. Verdict: verified.\n");
  git(root,"add",".");
  git(root,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid",
    "commit","-qm","Synthetic original Spec Kit Bugfix artifacts and verified tiny code fix");
  const commit=git(root,"rev-parse","HEAD");
  const intake:IntakeContract={version:1,scenario:"bugfix",size:"bounded",
    userGoal:"Correct callback without introducing new features",
    userScenarios:["Missing token returns null without exception"],
    scope:["Fix missing token handling in app.mjs"],
    nonGoals:["No authentication provider redesign"],
    acceptance:["Missing token no longer raises TypeError"],
    options:[],artifacts:{version:1,scenario:"bugfix",phase:"approved",commit,
      task:origin,artifactDirectory:folder,artifacts:paths,dependsOn:[]}};
  const stages:OriginalScenarioStageEvidence[]=(["assessment","fix","test"] as const)
    .map(stage=>({stage,sourceRef:"host-stage-"+stage,workerId:stage==="test"?"reviewer":"developer",
      commit,artifact:paths[stage]}));
  const scope=intakeDigest(intake);
  const checks:BugfixCheck[]=[
    {name:"Original reproducer",command:"node repro.mjs",result:"pass",sourceRef:"host-repro-731"},
    {name:"Regression tests",command:"node regression.mjs",result:"pass",sourceRef:"host-regression-731"},
  ];
  const fix:BugfixFixEvidence={issue:731,pr:910,workerId:"developer",reproducedBefore:true,
    rootCause:"Absent token dereferenced",changedFiles:["app.mjs"],approvedFiles:["app.mjs"],
    tests:checks,verdict:"verified",reviewerRef:"host-reviewer-731",
    implementedRef:"host-implement-731",recordedScopeDigest:scope};
  const verifyOwner=async(e:OwnerApprovalEvidence,x:{kind:string;digest:string})=>
    e.userMessageRef==="host-owner-approval-731"&&e.kind===x.kind&&e.reviewedDigest===x.digest;
  const ownerEvidence:OwnerApprovalEvidence[]=[
    {kind:"scope",userMessageRef:"host-owner-approval-731",reviewedDigest:scope}];
  const verifyStage=async(e:OriginalScenarioStageEvidence,x:{stage:string;issue:number;artifact:string;sourceHash:string})=>
    e.sourceRef==="host-stage-"+x.stage&&e.stage===x.stage&&x.issue===731&&
    e.artifact===x.artifact&&x.sourceHash.length===64;
  const verifyFix=async(f:BugfixFixEvidence,x:{issue:number;pr:number;scopeDigest:string;verdict:string})=>
    f.reviewerRef==="host-reviewer-731"&&f.implementedRef==="host-implement-731"&&
    x.issue===731&&x.pr===910&&x.scopeDigest===scope&&x.verdict==="verified";
  const verifyCheck=async(check:BugfixCheck)=>
    check.sourceRef==="host-"+(check.name.startsWith("Original")?"repro":"regression")+"-731";
  const request=()=>({root,intake,ownerEvidence,verifyOwner,originalStages:stages,
    verifyStage,fix,verifyFix,verifyCheck});
  return {root,intake,stages,checks,fix,request};
}

test("original Spec Kit Bugfix fixture reproduces, locates cause, tests fix, and hands to Main Agent",async()=>{
  const f=await fixture();
  try{
    const outcome=await assessBugfixReadiness(f.request());
    assert.equal(outcome.status,"final_review_required");
    assert.equal(outcome.readyForOwnerAcceptance,true);
    assert.equal(outcome.ownerApproved,false);
    assert.equal(outcome.issue,731);
    assert.equal(outcome.pr,910);
    assert.deepEqual(outcome.canonicalArtifacts,[
      ".specify/bugs/callback-token/assessment.md",
      ".specify/bugs/callback-token/fix.md",
      ".specify/bugs/callback-token/test.md"]);
    assert.equal((await readFile(join(f.root,"app.mjs"),"utf8")).includes("?."),true);
  }finally{await rm(f.root,{recursive:true,force:true})}
});

test("ordered original Bugfix stages require authenticated records, never inferred pass",async()=>{
  const f=await fixture();
  try{
    const opts=f.request();
    for(const size of [0,1,2]){
      const s=await assessBugfixReadiness({...opts,originalStages:f.stages.slice(0,size)});
      assert.equal(s.readyForOwnerAcceptance,false);
      assert.match(s.status,/awaiting_/);
    }
    await assert.rejects(assessBugfixReadiness({...opts,
      originalStages:[f.stages[0]!,f.stages[2]!]}),/ordered/);
    await assert.rejects(assessBugfixReadiness({...opts,verifyStage:async()=>false}),
      /not independently trusted/);
    const corrupt=structuredClone(opts.originalStages);
    corrupt[1]!.sourceRef="model-text";
    await assert.rejects(assessBugfixReadiness({...opts,originalStages:corrupt}),
      /not independently trusted/);
  }finally{await rm(f.root,{recursive:true,force:true})}
});

test("missing verified original reproducer, regression or partial checks block acceptance",async()=>{
  const f=await fixture();
  try{
    for(const replacement of [
      {tests:f.checks.slice(0,1)},
      {tests:f.checks.map(c=>({...c,result:"not-run" as const})),verdict:"partial" as const},
      {tests:f.checks.map(c=>({...c,result:"fail" as const})),verdict:"failed" as const},
    ]){
      const variant={...f.fix,...replacement};
      const request={...f.request(),fix:variant,verifyFix:async()=>true};
      if(variant.tests.length<2)
        await assert.rejects(assessBugfixReadiness(request),/separately verify/);
      else assert.equal((await assessBugfixReadiness(request)).status,"needs_rework");
    }
    const fake={...f.fix,reproducedBefore:false};
    await assert.rejects(assessBugfixReadiness({...f.request(),fix:fake}),/invalid/);
  }finally{await rm(f.root,{recursive:true,force:true})}
});

test("changed files outside owner-approved scope and fabricated evidence fail closed",async()=>{
  const f=await fixture();
  try{
    await assert.rejects(assessBugfixReadiness({...f.request(),
      fix:{...f.fix,changedFiles:["app.mjs","billing.mjs"]}}),/invalid/);
    await assert.rejects(assessBugfixReadiness({...f.request(),
      verifyCheck:async()=>false}),/verified host execution/);
    await assert.rejects(assessBugfixReadiness({...f.request(),
      verifyOwner:async()=>false}),/Owner-approved/);
    const temp=f.request();temp.fix={...f.fix,recordedScopeDigest:"0".repeat(64)};
    await assert.rejects(assessBugfixReadiness(temp),/invalid/);
  }finally{await rm(f.root,{recursive:true,force:true})}
});

test("source SHA and tampering of canonical Bugfix stage artifacts fail closed",async()=>{
  const f=await fixture();
  try{
    const original=await verifyOriginalScenarioCommand(f.root,"bug","assess");
    assert.match(original.content,/Assess Bug/);
    await writeFile(join(f.root,".specify/bugs/callback-token/test.md"),"Fabricated success");
    await assert.rejects(assessBugfixReadiness(f.request()),/bytes differ|artifact drift/);
  }finally{await rm(f.root,{recursive:true,force:true})}
});
