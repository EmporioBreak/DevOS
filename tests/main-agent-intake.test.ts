import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp,mkdir,readFile,writeFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { classifyIntake,decideIntake,intakeDigest,validateIntakeContract,
  type IntakeContract,type OwnerApprovalEvidence, type ApprovalKind } from "../src/main-agent-intake.js";
import type { SpecKitArtifactContract } from "../src/spec-kit-contract.js";

const repo="EmporioBreak/DevOS";
const git=(root:string,...args:string[])=>execFileSync("git",["-C",root,...args],{encoding:"utf8"}).trim();
async function fixture(scenario:"feature"|"bugfix"|"assess"="feature") {
  const root=await mkdtemp(join(tmpdir(),"devos-intake-"));
  git(root,"init","-q");
  const issue=301;
  const dir=scenario==="feature"?"specs/301-new-app":
    scenario==="bugfix"?".specify/bugs/checkout-error":".specify/assessments/offline-search";
  const filenames=scenario==="feature"?["spec","plan","tasks"]:
    scenario==="bugfix"?["assessment","fix","test"]:
      ["intake","research","problem","concept","decision"];
  await mkdir(join(root,dir),{recursive:true});
  const artifacts=Object.fromEntries(filenames.map(k=>[k,dir+"/"+k+".md"]));
  for(const name of filenames)
    await writeFile(join(root,artifacts[name]!),
      "# "+name+"\n\nOwner-approved example with input, measurable scope and constraints.\n");
  git(root,"add",".");
  git(root,"-c","user.name=Test","-c","user.email=test@example.invalid",
    "commit","-qm","Synthetic approved original Spec Kit artifacts");
  const sha=git(root,"rev-parse","HEAD");
  const contract:SpecKitArtifactContract={version:1,task:{repo,issue},scenario,
    phase:"approved",commit:sha,artifactDirectory:dir,artifacts,dependsOn:[]};
  return {root,contract};
}
function input(contract:SpecKitArtifactContract,kind:"feature"|"change"|"bugfix"|"assessment"="feature",
  size:"architectural"|"bounded"|"spike"="architectural"):IntakeContract{
  return {version:1,scenario:kind,size,userGoal:"Ship a reliable approved outcome",
    userScenarios:["A user completes the flow offline"],
    scope:["Offline search and keyboard support"],
    nonGoals:["No external billing integrations"],
    acceptance:["Offline search results are stable under refresh"],
    options:[{id:"local",benefits:"Simple deployment",risks:"Larger local store"},
      {id:"remote",benefits:"Central changes",risks:"Offline unavailable"}],
    selectedOption:"local",artifacts:contract,
    ...(kind==="change"?{existingProduct:"Existing dashboard, current homepage baseline"}:{})};
}
const approval=(c:IntakeContract,kind:ApprovalKind,ref="host-message-123"):
OwnerApprovalEvidence=>({kind,reviewedDigest:intakeDigest(c),userMessageRef:ref});
const verified=async (e:OwnerApprovalEvidence,expected:{digest:string;kind:ApprovalKind})=>
  e.userMessageRef==="host-message-123" && e.kind===expected.kind &&
  e.reviewedDigest===expected.digest;
const all=(c:IntakeContract)=>["scope","spec","plan"].map(x=>approval(c,x as ApprovalKind));

test("routing covers full new app, homepage redesign, defect and pure assessment",()=>{
  assert.deepEqual(classifyIntake({text:"Create a new app for offline search"}),
    {scenario:"feature",size:"architectural",needsClarification:false});
  assert.deepEqual(classifyIntake({text:"Переделай главную страницу редизайн"}),
    {scenario:"change",size:"architectural",needsClarification:false});
  assert.deepEqual(classifyIntake({text:"Исправь ошибку login callback"}),
    {scenario:"bugfix",size:"bounded",needsClarification:false});
  assert.deepEqual(classifyIntake({text:"Оцени концепцию offline search"}),
    {scenario:"assessment",size:"spike",needsClarification:false});
  assert.equal(classifyIntake({text:"make that better"}).needsClarification,true);
  assert.equal(classifyIntake({text:"create a new app and fix the bug"}).needsClarification,true);
  assert.equal(classifyIntake({text:"quick styling tweak",scenario:"change",size:"bounded"}).size,"bounded");
});

test("new app cannot start until exact scope, spec and plan approvals are verified",async()=>{
  const {root,contract}=await fixture();
  try{
    const c=input(contract);
    const missing=await decideIntake(c,{projectRoot:root});
    assert.equal(missing.status,"needs_owner_review");
    assert.equal(missing.missing.length,3);
    const fake=await decideIntake(c,{projectRoot:root,approvals:all(c)});
    assert.equal(fake.status,"needs_owner_review","Evidence strings without verifier are not proof");
    const partial=await decideIntake(c,{projectRoot:root,
      approvals:all(c).slice(0,2),verifyApproval:verified});
    assert.match(partial.missing.join(" " ),/plan/);
    const allowed=await decideIntake(c,{projectRoot:root,
      approvals:all(c),verifyApproval:verified});
    assert.equal(allowed.status,"approved_for_issue");
    assert.equal(allowed.needsNewOwnerReview,false);
    assert.match(allowed.nextSteps.join(" "),/Freeze declared worker graph/);
    const rerun=await decideIntake(c,{projectRoot:root,approvals:all(c),verifyApproval:verified});
    assert.deepEqual(rerun,allowed,"same task revision rework doesn't require another decision");
    assert.equal(allowed.approvalDigest,intakeDigest(c));
  } finally {await rm(root,{recursive:true,force:true})}
});

test("changed homepage baseline/new design requires independently reviewed new scope",async()=>{
  const {root,contract}=await fixture();
  try{
    const c=input(contract,"change");
    const original=await decideIntake(c,{projectRoot:root,approvals:all(c),verifyApproval:verified});
    assert.equal(original.status,"approved_for_issue");
    const newVersion={...c,previousApprovalDigest:intakeDigest(c),
      scope:["New navigation and homepage hero, excluding app settings"]};
    assert.notEqual(intakeDigest(c),intakeDigest(newVersion));
    const invalid=await decideIntake(newVersion,{projectRoot:root,approvals:all(c),verifyApproval:verified});
    assert.equal(invalid.status,"scope_change_blocked");
    const fresh=await decideIntake(newVersion,{projectRoot:root,
      approvals:all(newVersion),verifyApproval:verified});
    assert.equal(fresh.status,"approved_for_issue");
    const {existingProduct:_baseline,...withoutBaseline}=c;
    assert.throws(()=>validateIntakeContract(withoutBaseline),/baseline/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("bugfix uses original Bugfix files and bounded scope, not feature graph",async()=>{
  const {root,contract}=await fixture("bugfix");
  try{
    const c=input(contract,"bugfix","bounded");
    const missing=await decideIntake(c,{projectRoot:root});
    assert.deepEqual(missing.missing,["scope owner approval not independently verified"]);
    const accepted=await decideIntake(c,{projectRoot:root,approvals:[approval(c,"scope")],
      verifyApproval:verified});
    assert.equal(accepted.status,"approved_for_issue");
    assert.throws(()=>validateIntakeContract({...c,artifacts:{...contract,
      scenario:"feature"}}),/Bugfix/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("assessment stays assessment-only and never authorizes a PR or Runner",async()=>{
  const {root,contract}=await fixture("assess");
  try{
    const c=input(contract,"assessment","spike");
    const state=await decideIntake(c,{projectRoot:root});
    assert.equal(state.status,"assessment_only");
    assert.match(state.nextSteps.join(" "),/No Issue, PR or Runner/);
    assert.equal(state.missing.length,0);
    assert.throws(()=>validateIntakeContract({...c,artifacts:{...contract,
      scenario:"bugfix"}}),/Assessment/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("tampered, missing or uncommitted canonical Spec Kit artifacts fail before approval",async()=>{
  const {root,contract}=await fixture();
  try{
    const c=input(contract);
    await assert.rejects(decideIntake(c,{approvals:all(c),verifyApproval:verified}),/must be independently verified/);
    await writeFile(join(root,contract.artifacts.plan!),"Unreviewed rewrite");
    await assert.rejects(decideIntake(c,{projectRoot:root,approvals:all(c),
      verifyApproval:verified}),/differ from pinned revision/);
    await assert.rejects(decideIntake(input({...contract,commit:"f".repeat(40)}),
      {projectRoot:root,approvals:all(c),verifyApproval:verified}),/not available/);
  }finally{await rm(root,{recursive:true,force:true})}
});
