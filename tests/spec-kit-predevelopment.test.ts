import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp,mkdir,cp,writeFile,readFile,rm } from "node:fs/promises";
import { tmpdir,homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {inspectSpecKitPredevelopment,
  type OriginalStageProof,type PredevelopmentPolicy,type OriginalSDDStage,
} from "../src/spec-kit-predevelopment.js";
import {decideIntake,intakeDigest,type IntakeContract} from "../src/main-agent-intake.js";
import type {SpecKitArtifactContract} from "../src/spec-kit-contract.js";

const git=(root:string,...args:string[])=>execFileSync("git",["-C",root,...args],{encoding:"utf8"}).trim();
const upstream=join(homedir(),".devos-staging","upstream");
const stageList:OriginalSDDStage[]=["constitution","specify","clarify",
  "plan","checklist","tasks","analyze"];
const options={
  library:JSON.parse(await readFile("config/devos-skills.json","utf8")),
  qualityPolicy:JSON.parse(await readFile("config/devos-quality-methods.json","utf8")),
  stagePins:JSON.parse(await readFile("config/devos-speckit-stage-pins.json","utf8")),
  roots:{projectRoot:"",upstreamRoot:upstream,
    upstreamPins:{superpowers:"8ca22dba9a94f28898bbce59f2537ff4d87c747d"}},
};
const policy=(all=false):PredevelopmentPolicy=>({
  clarify:all,checklist:all,analyze:all,
});
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"devos-original-sdd-"));
  git(root,"init","-q");
  const folder="specs/001-offline-app";
  const artifacts={spec:folder+"/spec.md",plan:folder+"/plan.md",
    tasks:folder+"/tasks.md",checklist:folder+"/checklists/requirements.md"};
  await mkdir(join(root,folder,"checklists"),{recursive:true});
  for(const [name,path] of Object.entries(artifacts))
    await writeFile(join(root,path),
      "# "+name+"\n\nOriginal canonical Spec Kit template output; scope and tests documented.\n");
  const constitution=".specify/memory/constitution.md";
  await mkdir(join(root,".specify","memory"),{recursive:true});
  await writeFile(join(root,constitution),
    "# Offline App Constitution\n\nI. Every approved requirement has automated tests.\n"+
    "II. Security checks precede execution.\nGovernance: Owner ratified on 2026-10-09.\n");
  for(const stage of stageList){
    const dest=join(root,".agents","skills","speckit-"+stage);
    await mkdir(dest,{recursive:true});
    await cp(join(".agents","skills","speckit-"+stage,"SKILL.md"),
      join(dest,"SKILL.md"));
  }
  git(root,"add",".");
  git(root,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid",
    "commit","-qm","Committed original Spec Kit predevelopment fixture");
  const commit=git(root,"rev-parse","HEAD");
  const contract:SpecKitArtifactContract={version:1,task:{repo:"EmporioBreak/DevOS",issue:601},
    scenario:"feature",phase:"approved",commit,artifactDirectory:folder,
    artifacts,dependsOn:[]};
  const filesFor=(stage:OriginalSDDStage)=>stage==="constitution"?[constitution]:
    stage==="specify"||stage==="clarify"?[artifacts.spec]:
      stage==="plan"?[artifacts.plan]:
        stage==="checklist"?[artifacts.checklist]:
          stage==="tasks"?[artifacts.tasks]:
            [artifacts.spec,artifacts.plan,artifacts.tasks];
  const proof=(stage:OriginalSDDStage):OriginalStageProof=>({
    stage,commit,sourceRef:"trusted-host-stage-"+stage,
    files:filesFor(stage),result:"passed",
    actor:stage==="checklist"?"reviewer":"main_agent",
  });
  const opts={...options,roots:{...options.roots,projectRoot:root}};
  return {root,contract,proof,opts,artifacts};
}
const verify=async (proof:OriginalStageProof,expected:{stage:OriginalSDDStage;commit:string})=>
  proof.sourceRef==="trusted-host-stage-"+expected.stage &&
  proof.commit===expected.commit&&proof.stage===expected.stage;

test("full original Spec Kit predevelopment progresses and keeps one canonical spec/plan/tasks",async()=>{
  const {root,contract,proof,opts,artifacts}=await fixture();
  try{
    const all=policy(true);
    for(let i=0;i<stageList.length;i++){
      const evidence=stageList.slice(0,i).map(proof);
      const decision=await inspectSpecKitPredevelopment(
        root,contract,all,evidence,verify,opts);
      assert.equal(decision.nextStage,stageList[i]);
      assert.equal(decision.nextOriginalSkill,"speckit-"+stageList[i]);
      assert.equal(decision.readyForIntakeApproval,false);
    }
    const final=await inspectSpecKitPredevelopment(root,contract,all,
      stageList.map(proof),verify,opts);
    assert.equal(final.nextStage,null);
    assert.equal(final.readyForIntakeApproval,true);
    assert.equal(final.completed.length,7);
    assert.deepEqual(final.skipped,[]);
    for(const file of [artifacts.spec,artifacts.plan,artifacts.tasks])
      assert.ok((await readFile(join(root,file),"utf8")).includes("Original canonical"));
    // The workflow runs from original stage files but does not modify them.
    for(const stage of stageList) {
      const actual=await readFile(join(root,".agents","skills","speckit-"+stage,"SKILL.md"));
      const original=await readFile(join(".agents","skills","speckit-"+stage,"SKILL.md"));
      assert.deepEqual(actual,original);
    }
  }finally{await rm(root,{recursive:true,force:true})}
});

test("small change skips optional Clarify, Checklist and Analyze, preserving original Constitution",async()=>{
  const {root,contract,proof,opts}=await fixture();
  try{
    const required=["constitution","specify","plan","tasks"] as OriginalSDDStage[];
    const state=await inspectSpecKitPredevelopment(root,contract,policy(),
      required.map(proof),verify,opts);
    assert.equal(state.readyForIntakeApproval,true);
    assert.deepEqual(state.skipped,["clarify","checklist","analyze"]);
    assert.deepEqual(state.completed,required);
    const after=await inspectSpecKitPredevelopment(root,contract,policy(),
      required.map(proof),verify,opts);
    assert.deepEqual(after,state,"project Constitution is reused rather than rewritten");
  }finally{await rm(root,{recursive:true,force:true})}
});

test("quality conflict returns to earliest appropriate original stage, no silent passed gate",async()=>{
  const {root,contract,proof,opts}=await fixture();
  try {
    const check=await inspectSpecKitPredevelopment(root,contract,policy(true),
      stageList.map(proof),verify,opts,[
        {fromStage:"analyze",target:"tasks",severity:"major",resolved:false,detail:"Missing test"},
        {fromStage:"checklist",target:"specify",severity:"critical",resolved:false,detail:"Scope gap"},
      ]);
    assert.equal(check.returnToStage,"specify");
    assert.equal(check.nextStage,"specify");
    assert.equal(check.readyForIntakeApproval,false);
    const fixed=await inspectSpecKitPredevelopment(root,contract,policy(true),
      stageList.map(proof),verify,opts,[
        {fromStage:"analyze",target:"tasks",severity:"major",resolved:true,detail:"Covered"},
      ]);
    assert.equal(fixed.readyForIntakeApproval,true);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("reviewer owns Checklist result, skipped or forged stages are rejected",async()=>{
  const {root,contract,proof,opts}=await fixture();
  try{
    const wrong=stageList.map(proof);
    wrong[4]={...wrong[4]!,actor:"main_agent"};
    await assert.rejects(inspectSpecKitPredevelopment(root,contract,policy(true),
      wrong,verify,opts),/does not match reviewed stage/);
    const untrusted=await inspectSpecKitPredevelopment(root,contract,policy(true),
      stageList.map(proof),async()=>false,opts);
    assert.fail("Untrusted checklist should have thrown, got "+JSON.stringify(untrusted));
  }catch(error){
    if(error instanceof Error&&error.message.startsWith("Untrusted checklist should"))throw error;
    assert.match(String(error),/not trusted|does not match/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("untrusted, out-of-order, unratified Constitution or modified original plan fail closed",async()=>{
  const {root,contract,proof,opts,artifacts}=await fixture();
  try{
    await assert.rejects(inspectSpecKitPredevelopment(root,contract,policy(),
      [proof("tasks")],verify,opts),/must be ordered/);
    const unverified=proof("constitution");unverified.sourceRef="fake-proof";
    await assert.rejects(inspectSpecKitPredevelopment(root,contract,policy(),
      [unverified],verify,opts),/not trusted/);
    const real=await readFile(join(root,".specify","memory","constitution.md"),"utf8");
    await writeFile(join(root,".specify","memory","constitution.md"),
      "# [PROJECT_NAME] Constitution\n[PRINCIPLE_1_NAME]\n");
    await assert.rejects(inspectSpecKitPredevelopment(root,contract,policy(),
      [proof("constitution")],verify,opts),/drift/);
    await writeFile(join(root,".specify","memory","constitution.md"),real);
    await writeFile(join(root,artifacts.plan),"Unauthorized edits");
    await assert.rejects(inspectSpecKitPredevelopment(root,contract,policy(),
      [proof("constitution"),proof("specify"),proof("plan")],verify,opts),/drift/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("end of SDD predevelopment still requires separately verified owner scope/spec/plan consent",async()=>{
  const {root,contract,proof,opts}=await fixture();
  try{
    const state=await inspectSpecKitPredevelopment(root,contract,policy(true),
      stageList.map(proof),verify,opts);
    assert.equal(state.readyForIntakeApproval,true);
    const intake:IntakeContract={version:1,scenario:"feature",size:"architectural",
      userGoal:"Offline search app",userScenarios:["User searches offline"],
      scope:["Offline search feature"],nonGoals:["No user billing"],
      acceptance:["Offline results deterministic"],
      options:[{id:"local",benefits:"Offline",risks:"Storage"},
        {id:"remote",benefits:"Sync",risks:"Network dependence"}],
      selectedOption:"local",artifacts:contract};
    const denied=await decideIntake(intake,{projectRoot:root});
    assert.equal(denied.status,"needs_owner_review");
    const approvals=(["scope","spec","plan"] as const).map(kind=>({
      kind,userMessageRef:"trusted-owner-message",reviewedDigest:intakeDigest(intake)}));
    const accepted=await decideIntake(intake,{projectRoot:root,approvals,
      verifyApproval:async (e,x)=>e.userMessageRef==="trusted-owner-message" &&
        e.kind===x.kind && e.reviewedDigest===x.digest});
    assert.equal(accepted.status,"approved_for_issue");
  }finally{await rm(root,{recursive:true,force:true})}
});
