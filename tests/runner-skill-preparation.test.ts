import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,mkdir,cp,readFile,writeFile,rm} from "node:fs/promises";
import {tmpdir,homedir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {intakeDigest,type IntakeContract,type OwnerApprovalEvidence} from "../src/main-agent-intake.js";
import {projectGraphDigest,type MainAgentProjectPlan,
  type ProjectIssuePlan} from "../src/main-agent-project-plan.js";
import {prepareApprovedRunnerSkills,issueSkillsApprovalDigest,
  type ApprovedWorkerChoice} from "../src/runner-skill-preparation.js";
import {verifyRunnerSkillGraph} from "../src/runner-skill-graph.js";
import {readWorkerSkillManifest} from "../src/skill-policy.js";
import type {Workflow} from "../src/workflow.js";

const secret="trusted-owner-staging-roster-key-".repeat(3);
const upstreamRoot=join(homedir(),".devos-staging","upstream");
const git=(root:string,...args:string[])=>execFileSync("git",["-C",root,...args],{encoding:"utf8"}).trim();
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"devos-seal-approved-"));
  git(root,"init","-q");
  await mkdir(join(root,"config"),{recursive:true});
  for(const name of ["devos-skills.json","devos-skill-policy.json",
      "devos-quality-methods.json","devos-upstreams.lock.json",
      "devos-speckit-stage-pins.json"])
    await cp(join("config",name),join(root,"config",name));
  await mkdir(join(root,".agents","skills","speckit-implement"),{recursive:true});
  await cp(".agents/skills/speckit-implement/SKILL.md",
    join(root,".agents","skills","speckit-implement","SKILL.md"));
  const prefix="specs/744-task",artifacts={spec:prefix+"/spec.md",
    plan:prefix+"/plan.md",tasks:prefix+"/tasks.md"};
  await mkdir(join(root,prefix),{recursive:true});
  for(const [key,path] of Object.entries(artifacts))
    await writeFile(join(root,path),"# "+key+"\n\nOwner-reviewed synthetic original artifact.\n");
  git(root,"add",".");
  git(root,"-c","user.name=Fixture","-c","user.email=test@example.invalid",
    "commit","-qm","Pinned planning and spec files");
  const commit=git(root,"rev-parse","HEAD");
  const repo="EmporioBreak/DevOS",issue=744,pr=917;
  const intent:IntakeContract={version:1,scenario:"feature",size:"bounded",
    userGoal:"Add a validated new data module",userScenarios:["A user runs the query"],
    scope:["Add endpoint under data module"],nonGoals:["Do not change payments"],
    acceptance:["Endpoint returns a deterministic response"],
    options:[],artifacts:{version:1,task:{repo,issue},scenario:"feature",
      phase:"approved",commit,artifactDirectory:prefix,artifacts,dependsOn:[]}};
  const workflow:Workflow={version:1,skillsMode:"strict",
    owner:{mode:"main_agent"},task:{repo,issue,pr},start:"developer",
    workers:[
      {id:"developer",executor:"chatgpt_browser",
        prompt:"Implement exact approved Issue",on:{
          done:"reviewer",needs_local_worker:"host",failed:null,
        }},
      {id:"host",executor:"codex",prompt:"Only after browser blocker",
        on:{done:"reviewer",failed:null}},
      {id:"reviewer",executor:"chatgpt_browser",
        prompt:"Independent review",on:{approved:null,changes_requested:"developer",failed:null}},
    ]};
  const msg=(digest:string):OwnerApprovalEvidence=>({
    kind:"plan",reviewedDigest:digest,userMessageRef:"host-attested-user-decision"});
  const entry:ProjectIssuePlan={key:"data-module",issue,
    title:"Data module",
    intent,ownerEvidence:[{kind:"scope",reviewedDigest:intakeDigest(intent),
      userMessageRef:"host-attested-user-decision"}],
    graphApproval:msg("0".repeat(64)),
    dependsOn:[],linkedPr:pr,workflow};
  const project:MainAgentProjectPlan={version:1,repo,epic:121,issues:[entry]};
  // This Epic is included in the exact owner-approved original artifact identity.
  entry.intent.artifacts!.epic=121;
  entry.ownerEvidence[0]!.reviewedDigest=intakeDigest(entry.intent);
  entry.graphApproval=msg(projectGraphDigest(entry,121));
  const choices:ApprovedWorkerChoice[]=[
    {workerId:"developer",role:"developer",phase:"execution",
      specKitStage:"implement",optionalCandidates:["superpowers-test-driven-development"]},
    {workerId:"host",role:"developer",phase:"execution",
      specKitStage:"implement",optionalCandidates:["superpowers-test-driven-development"]},
    {workerId:"reviewer",role:"reviewer",phase:"execution",
      specKitStage:null,optionalCandidates:[]},
  ];
  const rosterApproval=msg(issueSkillsApprovalDigest(project,issue,choices));
  const verifyOwner=async (e:OwnerApprovalEvidence,x:{kind:string;digest:string})=>
    e.userMessageRef==="host-attested-user-decision" &&
    e.kind===x.kind && e.reviewedDigest===x.digest;
  const args=()=>({root,project,issue,choices,rosterApproval,verifyOwner,ownerSecret:secret,
    upstreamRoot});
  return {root,project,choices,args};
}
test("approved Main Agent project plan binds exact skill choices and seals all Runner workers",async()=>{
  const f=await fixture();
  try{
    const result=await prepareApprovedRunnerSkills(f.args());
    assert.deepEqual(result.workers,["developer","host","reviewer"]);
    assert.match(result.graphSha256,/^[a-f0-9]{64}$/);
    assert.equal(result.rosterDigest,issueSkillsApprovalDigest(f.project,744,f.choices));
    const sealed=await verifyRunnerSkillGraph(f.root,f.project.issues[0]!.workflow,
      secret,upstreamRoot);
    assert.equal(sealed.workers.length,3);
    const manifest=await readWorkerSkillManifest(f.root,
      {repo:"EmporioBreak/DevOS",issue:744},"host",secret);
    assert.equal(manifest.selected[0]!.id,"superpowers-test-driven-development");
    assert.equal(manifest.specKitStage,"implement");
    // Restart / same worktree can only replay the same bytes, not new choices.
    assert.deepEqual(await prepareApprovedRunnerSkills(f.args()),result);
  }finally{await rm(f.root,{recursive:true,force:true})}
});
test("fake approval, altered roster, absent source and altered Issue graph never seal",async()=>{
  const f=await fixture();
  try{
    await assert.rejects(prepareApprovedRunnerSkills({...f.args(),
      verifyOwner:async()=>false}),/not owner-approved/);
    const changed=[...f.choices];
    changed[0]={...changed[0]!,specKitStage:null};
    await assert.rejects(prepareApprovedRunnerSkills({...f.args(),choices:changed}),
      /lacks independent owner approval/);
    await assert.rejects(verifyRunnerSkillGraph(f.root,
      f.project.issues[0]!.workflow,secret,upstreamRoot),/ENOENT/);
    const invalid=structuredClone(f.project);
    invalid.issues[0]!.workflow.workers.push({id:"surprise",
      executor:"chatgpt_browser",prompt:"Unapproved agent",on:{done:null}});
    await assert.rejects(prepareApprovedRunnerSkills({...f.args(),project:invalid}),
      /full worker graph/);
  }finally{await rm(f.root,{recursive:true,force:true})}
});
