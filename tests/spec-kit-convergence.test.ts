import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp,mkdir,cp,readFile,writeFile,rm } from "node:fs/promises";
import {tmpdir,homedir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {convergeSpecKitTasks,parseCanonicalTasks,type TrustedConvergeReport} from "../src/spec-kit-convergence.js";
import type {IntakeContract} from "../src/main-agent-intake.js";

const git=(root:string,...args:string[])=>execFileSync("git",["-C",root,...args],{encoding:"utf8"}).trim();
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
const options={
  library:JSON.parse(await readFile("config/devos-skills.json","utf8")),
  qualityPolicy:JSON.parse(await readFile("config/devos-quality-methods.json","utf8")),
  stagePins:JSON.parse(await readFile("config/devos-speckit-stage-pins.json","utf8")),
  roots:{projectRoot:"",upstreamRoot:join(homedir(),".devos-staging","upstream"),
    upstreamPins:{superpowers:"8ca22dba9a94f28898bbce59f2537ff4d87c747d"}},
};
async function fixture(complete=true){
  const root=await mkdtemp(join(tmpdir(),"devos-original-converge-"));
  git(root,"init","-q");
  const folder="specs/002-confirmed-app";
  const paths={spec:folder+"/spec.md",plan:folder+"/plan.md",tasks:folder+"/tasks.md"};
  await mkdir(join(root,folder),{recursive:true});
  await writeFile(join(root,paths.spec),
    "# Feature\n## Acceptance\n- Input validation\n- Results deterministic\n");
  await writeFile(join(root,paths.plan),"# Plan\nInterfaces and exact tests.\n");
  await writeFile(join(root,paths.tasks),
    "# Tasks\n\n## Phase 1: Foundational\n"+
    (complete?"- [x] T001 [US1] Implement tests\n":"- [ ] T001 [US1] Implement tests\n")+
    (complete?"- [x] T002 [US1] Implement verified feature\n":"- [ ] T002 [US1] Implement verified feature\n"));
  await mkdir(join(root,".agents","skills","speckit-converge"),{recursive:true});
  await cp(".agents/skills/speckit-converge/SKILL.md",
    join(root,".agents","skills","speckit-converge","SKILL.md"));
  git(root,"add",".");
  git(root,"-c","user.name=Test","-c","user.email=test@example.invalid",
    "commit","-qm","Synthetic original implement stage and pinned original spec/plan");
  const sha=git(root,"rev-parse","HEAD");
  const intent:IntakeContract={version:1,scenario:"feature",size:"architectural",
    userGoal:"Validated app",userScenarios:["Users receive deterministic results"],
    scope:["Input validation and deterministic search"],
    nonGoals:["No billing"],
    acceptance:["Input validation","Results deterministic"],
    options:[{id:"local",benefits:"Works offline",risks:"Storage"},
      {id:"remote",benefits:"Sync",risks:"Network"}],selectedOption:"local",
    artifacts:{version:1,task:{repo:"EmporioBreak/DevOS",issue:602},
      scenario:"feature",phase:"approved",commit:sha,artifactDirectory:folder,
      artifacts:paths,dependsOn:[]}};
  const report=(gaps:TrustedConvergeReport["gaps"]):TrustedConvergeReport=>({
    issue:602,pr:810,workerId:"reviewer",sourceRef:"verified-review",
    implementationRef:"verified-implement",gaps});
  const args=(gaps:TrustedConvergeReport["gaps"],tasks:string)=>({
    root,approved:intent,issue:602,pr:810,expectedTasksSha256:hash(tasks),
    proof:report(gaps),verifyReport:async (record:TrustedConvergeReport,expected:{
      scopeDigest:string;gapDigest:string;issue:number;pr:number
    })=>record.sourceRef==="verified-review" &&
      record.implementationRef==="verified-implement" &&
      expected.issue===602 && expected.pr===810 && !!expected.gapDigest &&
      expected.scopeDigest.length===64,
    skillOptions:{...options,roots:{...options.roots,projectRoot:root}},
  });
  return {root,intent,paths,report,args};
}

test("parse original Spec Kit checklist tasks and detect duplicate/out-of-order IDs",()=>{
  assert.deepEqual(parseCanonicalTasks("- [x] T001 [US1] Test\n- [ ] T002 [US1] Fix\n")
    .map(x=>[x.id,x.checked]),[["T001",true],["T002",false]]);
  assert.throws(()=>parseCanonicalTasks("# no tasks"),/Missing/);
  assert.throws(()=>parseCanonicalTasks("- [x] T001 X\n- [x] T001 Y\n"),/Duplicate/);
  assert.throws(()=>parseCanonicalTasks("- [ ] T003 X\n- [ ] T002 Y\n"),/dependency order/);
});

test("clean convergence leaves original tasks.md byte-for-byte unchanged and hands off to Main Agent",async()=>{
  const {root,paths,args}=await fixture(true);
  try{
    const before=await readFile(join(root,paths.tasks),"utf8");
    const state=await convergeSpecKitTasks(args([],before));
    assert.equal(state.status,"final_review_required");
    assert.equal(state.ownerApproved,false);
    assert.equal(state.taskFileHash,hash(before));
    assert.deepEqual(state.newlyAdded,[]);
    assert.equal(await readFile(join(root,paths.tasks),"utf8"),before);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("append-only convergence adds numbered scoped tasks and safely handles repeated review",async()=>{
  const {root,paths,args}=await fixture(true);
  try{
    const original=await readFile(join(root,paths.tasks),"utf8");
    const specBefore=await readFile(join(root,paths.spec),"utf8");
    const planBefore=await readFile(join(root,paths.plan),"utf8");
    const gaps=[{acceptance:"Results deterministic",description:"Add stable tie-break to results"},
      {acceptance:"Input validation",description:"Add invalid input regression"}];
    const next=await convergeSpecKitTasks(args(gaps,original));
    assert.equal(next.status,"gaps_appended");
    assert.deepEqual(next.newlyAdded,["T003","T004"]);
    const after=await readFile(join(root,paths.tasks),"utf8");
    assert.ok(after.startsWith(original));
    assert.match(after,/## Phase 2: Convergence/);
    assert.equal(parseCanonicalTasks(after).length,4);
    const again=await convergeSpecKitTasks(args(gaps,after));
    assert.equal(again.status,"unchanged");
    assert.equal(await readFile(join(root,paths.tasks),"utf8"),after);
    assert.equal(await readFile(join(root,paths.spec),"utf8"),specBefore);
    assert.equal(await readFile(join(root,paths.plan),"utf8"),planBefore);
    assert.equal(next.ownerApproved,false);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("incomplete original tasks never yield false Main Agent handoff",async()=>{
  const {root,paths,args}=await fixture(false);
  try {
    const before=await readFile(join(root,paths.tasks),"utf8");
    const state=await convergeSpecKitTasks(args([],before));
    assert.equal(state.status,"needs_implementation");
    assert.equal(state.ownerApproved,false);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("new out-of-scope work, invalid reviewer proof or fake implementation are blocked",async()=>{
  const {root,paths,args}=await fixture(true);
  try{
    const before=await readFile(join(root,paths.tasks),"utf8");
    await assert.rejects(convergeSpecKitTasks(args([
      {acceptance:"Add new billing system",description:"Build payments"}],before)),/extend owner-approved scope/);
    const fake=args([{acceptance:"Input validation",description:"Fix boundary error"}],before);
    fake.proof.sourceRef="model-says-yes";
    await assert.rejects(convergeSpecKitTasks(fake),/not independently verified/);
    const unproven=args([{acceptance:"Input validation",description:"Fix boundary error"}],before);
    unproven.proof.implementationRef="fabricated-implement";
    await assert.rejects(convergeSpecKitTasks(unproven),/not independently verified/);
    assert.equal(await readFile(join(root,paths.tasks),"utf8"),before);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("stale checksum and modified original spec/plan fail without changing tasks",async()=>{
  const {root,paths,args}=await fixture(true);
  try{
    const before=await readFile(join(root,paths.tasks),"utf8");
    await assert.rejects(convergeSpecKitTasks({...args([],before),
      expectedTasksSha256:"f".repeat(64)}),/changed since trusted/);
    await writeFile(join(root,paths.spec),"unreviewed new specifications");
    await assert.rejects(convergeSpecKitTasks(args([
      {acceptance:"Input validation",description:"Fix edge case"}],before)),
      /original spec\/plan has changed/);
    assert.equal(await readFile(join(root,paths.tasks),"utf8"),before);
  }finally{await rm(root,{recursive:true,force:true})}
});
