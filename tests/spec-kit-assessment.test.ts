import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,mkdir,readFile,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {inspectSpecKitAssessment,type AssessmentDecision,type AssessmentEvidence} from "../src/spec-kit-assessment.js";
import type {OriginalScenarioStageEvidence} from "../src/spec-kit-scenarios.js";
import type {IntakeContract} from "../src/main-agent-intake.js";
const git=(root:string,...args:string[])=>execFileSync("git",["-C",root,...args],{encoding:"utf8"}).trim();
const fileOrder=["intake","research","problem","concept","decision"] as const;
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"devos-assess-fixture-"));
  git(root,"init","-q");
  await mkdir(join(root,"config"),{recursive:true});
  await writeFile(join(root,"config","devos-upstreams.lock.json"),
    await readFile("config/devos-upstreams.lock.json"));
  const folder=".specify/assessments/offline-search";
  await mkdir(join(root,folder),{recursive:true});
  const files=Object.fromEntries(fileOrder.map(s=>[s,folder+"/"+s+".md"]));
  const texts={
    intake:"# Idea\nCan users search without network?\n",
    research:"# Research\nEvidence for offline-first and cost concerns.\nSources: internal prototype benchmark.\n",
    problem:"# Problem\nUsers cannot search disconnected; 25% sessions lose connectivity.\n",
    concept:"# Options\nLocal index vs remote-only. Local index offers offline use with storage costs.\n",
    decision:"# Decision\nGO only to draft original Spec Kit feature after explicit owner approval.\n",
  };
  for(const stage of fileOrder)
    await writeFile(join(root,files[stage]!),texts[stage]);
  git(root,"add",".");
  git(root,"-c","user.name=Fixture","-c","user.email=test@example.invalid",
    "commit","-qm","Synthetic original Assessment artifacts");
  const commit=git(root,"rev-parse","HEAD");
  const intake:IntakeContract={version:1,scenario:"assessment",size:"spike",
    userGoal:"Evaluate offline search value",userScenarios:["User searches while offline"],
    scope:["Compare local and remote approaches"],nonGoals:["No implementation yet"],
    acceptance:["Evidence, tradeoffs and go/no-go recommendation"],
    options:[],artifacts:{version:1,scenario:"assess",phase:"approved",
      task:{repo:"EmporioBreak/DevOS",issue:732},commit,
      artifactDirectory:folder,artifacts:files,dependsOn:[]}};
  const proofs:OriginalScenarioStageEvidence[]=fileOrder.map(stage=>({
    stage,sourceRef:"verified-"+stage+"-event",workerId:"main_agent",
    commit,artifact:files[stage]!,
  }));
  const evidence:AssessmentEvidence[]=[
    {title:"Prototype benchmark",source:"documented local test benchmark",
      confidence:"high",supports:true},
    {title:"Offline storage risk",source:"technical prototype constraint",
      confidence:"medium",supports:false},
    {title:"Unverified market segment",source:"ASSUMPTION: third-party uptake",
      confidence:"assumption",supports:true},
  ];
  const full:AssessmentDecision={verdict:"go",
    rationale:"Offline pain is observed. Local index has measurable benefit and storage tradeoffs.",
    sourceRef:"verified-decision-event",
    scorecard:(["problem-validity","evidence-strength","value-vs-inaction",
      "feasibility","strategic-fit","risk-posture"] as const).map(criterion=>({
        criterion,rating:"adequate" as const,
        rationale:"Supported by prototype evidence and explicit risk analysis",
        evidenceRefs:["Prototype benchmark","Offline storage risk"]})),
    evidence,recommendedOption:"local index",
    openQuestions:["Measure memory footprint on low-end devices"],
    potentialFeatureScope:["Offline index with bounded disk use"]};
  const verifyStage=async(e:OriginalScenarioStageEvidence,x:{stage:string;issue:number;sourceHash:string})=>
    x.issue===732&&e.sourceRef==="verified-"+x.stage+"-event"&&x.sourceHash.length===64;
  const verifyDecision=async(e:AssessmentDecision,x:{issue:number;verdict:string;artifactCommit:string})=>
    e.sourceRef==="verified-decision-event"&&x.issue===732&&
    x.verdict===e.verdict&&x.artifactCommit===commit;
  return {root,commit,intake,proofs,full,verifyStage,verifyDecision,files};
}
test("original Assessment GO is a candidate only, without creating an Issue, PR or Runner",async()=>{
  const f=await fixture();
  try{
    const before=git(f.root,"status","--porcelain");
    const state=await inspectSpecKitAssessment({root:f.root,intake:f.intake,
      stageProofs:f.proofs,verifyStage:f.verifyStage,
      decision:f.full,verifyDecision:f.verifyDecision});
    assert.equal(state.status,"go_candidate");
    assert.equal(state.verdict,"go");
    assert.equal(state.requiresNewFeatureApproval,true);
    assert.equal(state.mayCreateIssue,false);
    assert.equal(state.mayCreatePr,false);
    assert.equal(state.mayRunRunner,false);
    assert.equal(git(f.root,"status","--porcelain"),before);
  }finally{await rm(f.root,{recursive:true,force:true})}
});
test("optional Intake/Research never force development, problem and Decide required",async()=>{
  const f=await fixture();
  try{
    const noStages=await inspectSpecKitAssessment({root:f.root,intake:f.intake,
      stageProofs:[],verifyStage:f.verifyStage});
    assert.equal(noStages.status,"needs_artifacts");
    const onlyProblem=await inspectSpecKitAssessment({root:f.root,intake:f.intake,
      stageProofs:[f.proofs[2]!],verifyStage:f.verifyStage});
    assert.equal(onlyProblem.status,"ready_for_decision");
    assert.equal(onlyProblem.nextOriginalCommand,"speckit.assess.decide");
    await assert.rejects(inspectSpecKitAssessment({root:f.root,intake:f.intake,
      stageProofs:[f.proofs[2]!,f.proofs[4]!],verifyStage:f.verifyStage,
      decision:f.full,verifyDecision:f.verifyDecision}),
      /Insufficient original concept/);
  }finally{await rm(f.root,{recursive:true,force:true})}
});
test("go requires adequate credible supporting evidence; assumptions never enough",async()=>{
  const f=await fixture();
  try{
    const bad=structuredClone(f.full);
    bad.scorecard.find(x=>x.criterion==="evidence-strength")!.rating="weak";
    await assert.rejects(inspectSpecKitAssessment({root:f.root,intake:f.intake,
      stageProofs:f.proofs,verifyStage:f.verifyStage,
      decision:bad,verifyDecision:f.verifyDecision}),/Insufficient original concept/);
    const fake=structuredClone(f.full);
    fake.scorecard.find(x=>x.criterion==="evidence-strength")!.evidenceRefs=[
      "Unverified market segment"];
    await assert.rejects(inspectSpecKitAssessment({root:f.root,intake:f.intake,
      stageProofs:f.proofs,verifyStage:f.verifyStage,
      decision:fake,verifyDecision:f.verifyDecision}),/Insufficient original concept/);
  }finally{await rm(f.root,{recursive:true,force:true})}
});
test("kill and needs-clarification are legitimate read-only final outcomes",async()=>{
  const f=await fixture();
  try{
    const kill={...f.full,verdict:"kill" as const,
      rationale:"Opportunity cost exceeds expected value"};
    const k=await inspectSpecKitAssessment({root:f.root,intake:f.intake,
      stageProofs:f.proofs,verifyStage:f.verifyStage,decision:kill,verifyDecision:f.verifyDecision});
    assert.equal(k.status,"kill");
    assert.equal(k.mayRunRunner,false);
    const clarify={...f.full,verdict:"needs-clarification" as const,
      openQuestions:["Need measured connectivity-loss evidence"]};
    const c=await inspectSpecKitAssessment({root:f.root,intake:f.intake,
      stageProofs:f.proofs,verifyStage:f.verifyStage,decision:clarify,
      verifyDecision:f.verifyDecision});
    assert.equal(c.status,"clarify");
    await assert.rejects(inspectSpecKitAssessment({root:f.root,intake:f.intake,
      stageProofs:f.proofs,verifyStage:f.verifyStage,
      decision:{...clarify,openQuestions:[]},verifyDecision:f.verifyDecision}),
      /blocking questions/);
  }finally{await rm(f.root,{recursive:true,force:true})}
});
test("untrusted sources, missing commitment or changed artifacts cannot claim valid assessment",async()=>{
  const f=await fixture();
  try{
    await assert.rejects(inspectSpecKitAssessment({root:f.root,intake:f.intake,
      stageProofs:f.proofs,verifyStage:async()=>false,
      decision:f.full,verifyDecision:f.verifyDecision}),/not independently trusted/);
    await assert.rejects(inspectSpecKitAssessment({root:f.root,intake:f.intake,
      stageProofs:f.proofs,verifyStage:f.verifyStage,
      decision:f.full,verifyDecision:async()=>false}),/not independently verified/);
    await writeFile(join(f.root,f.files.research!),"Faked citations");
    await assert.rejects(inspectSpecKitAssessment({root:f.root,intake:f.intake,
      stageProofs:f.proofs,verifyStage:f.verifyStage,
      decision:f.full,verifyDecision:f.verifyDecision}),/bytes differ/);
  }finally{await rm(f.root,{recursive:true,force:true})}
});
