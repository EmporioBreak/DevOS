import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {inspectMainAgentFinalReview,type OwnerPrSnapshot,
  type OwnerTestEvidence,type MainAgentReviewSource} from "../src/main-agent-final-review.js";
import type {IntakeContract} from "../src/main-agent-intake.js";
import type {RunState} from "../src/orchestrator.js";

const git=(root:string,...args:string[])=>execFileSync("git",["-C",root,...args],{encoding:"utf8"}).trim();
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"devos-owner-review-"));
  git(root,"init","-q");
  const repo="EmporioBreak/DevOS",issue=747,pr=923;
  const dir="specs/747-approved-feature";
  await mkdir(join(root,dir),{recursive:true});
  const artifact={spec:dir+"/spec.md",plan:dir+"/plan.md",tasks:dir+"/tasks.md"};
  await writeFile(join(root,artifact.spec),"# Approved search behavior\nOnly deterministic search accepted.\n");
  await writeFile(join(root,artifact.plan),"# Owner approved plan\nUse one deterministic data module.\n");
  const oldTasks="# Tasks\n\n## Phase 1: Implementation\n"+
    "- [ ] T001 [US1] Write regression test\n"+
    "- [ ] T002 [US1] Implement deterministic query\n";
  await writeFile(join(root,artifact.tasks),oldTasks);
  git(root,"add",".");
  git(root,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid",
    "commit","-qm","Approved canonical original SDD artifacts");
  const commit=git(root,"rev-parse","HEAD");
  await writeFile(join(root,artifact.tasks),
    oldTasks.replaceAll("- [ ]","- [x]")+
    "\n## Phase 2: Convergence\n\n- [x] T003 [US1] Verify order stability\n");
  const approved:IntakeContract={version:1,scenario:"feature",size:"bounded",
    userGoal:"Deterministic queries",userScenarios:["Search works identically twice"],
    scope:["Deterministic query output"],nonGoals:["No billing redesign"],
    acceptance:["Stable query results","Regression remains green"],
    options:[],artifacts:{version:1,task:{repo,issue},scenario:"feature",
      phase:"approved",commit,artifactDirectory:dir,artifacts:artifact,dependsOn:[]}};
  const state:RunState={currentWorkerId:"reviewer",completedRuns:4,
    sessions:{developer:"https://chatgpt.com/g/project/c/dev-747",
      reviewer:"https://chatgpt.com/g/project/c/review-747"},
    mainAgentReviewPending:true,completionApproved:false,task:{repo,issue,pr}};
  const headSha="b".repeat(40);
  const snapshot:OwnerPrSnapshot={repo,pr,linkedIssue:issue,headSha,state:"open",
    changedFiles:["src/search.ts","tests/search.test.ts"],
    reviewerStatus:"approved",reviewRef:"github-review-747"};
  const tests:OwnerTestEvidence[]=[{
    id:"search-regression",headSha,command:"npm test",
    passed:true,sourceRef:"verified-test-run-747",
    criteria:approved.acceptance,
  }];
  const source:MainAgentReviewSource={
    async pullRequest(){return snapshot;},
    async tests(){return tests;},
    async verifyTest(e,sha){return sha===headSha &&
      e.sourceRef==="verified-test-run-747" && e.passed;},
    async verifyReview(p){return p.reviewRef==="github-review-747";},
  };
  return {root,artifact,approved,state,source,snapshot,tests};
}
test("independent Main Agent check receives evidence but never auto-approves or merges",async()=>{
  const f=await fixture();
  try{
    const result=await inspectMainAgentFinalReview(f);
    assert.equal(result.status,"ready_for_main_agent_judgment");
    assert.deepEqual(result.acceptanceCovered,f.approved.acceptance);
    assert.deepEqual(result.completedTaskIds,["T001","T002","T003"]);
    assert.equal(result.workerReportsVerified,true);
    assert.equal(result.changedFileCount,2);
    assert.equal(result.ownerApproved,false);
    assert.equal(result.releaseOrMergeAuthorized,false);
    assert.equal(result.humanProductReviewRequired,true);
    assert.deepEqual(result.task,{repo:"EmporioBreak/DevOS",issue:747,pr:923});
  }finally{await rm(f.root,{recursive:true,force:true})}
});
test("missing PR review or failing/stale evidence returns changes required",async()=>{
  const f=await fixture();
  try {
    const noReview={...f.source,verifyReview:async()=>false};
    const result=await inspectMainAgentFinalReview({...f,source:noReview});
    assert.equal(result.status,"changes_required");
    assert.match(result.pending.join(" "),/Independent reviewer/);
    const failure={...f.source,tests:async()=>[{
      ...f.tests[0]!,passed:false,
    }]};
    const bad=await inspectMainAgentFinalReview({...f,source:failure});
    assert.equal(bad.status,"changes_required");
    assert.match(bad.pending.join(" "),/passing independently verified test/);
    assert.equal(bad.ownerApproved,false);
    const wrongHead={...f.source,tests:async()=>[{
      ...f.tests[0]!,headSha:"c".repeat(40),
    }]};
    const stale=await inspectMainAgentFinalReview({...f,source:wrongHead});
    assert.equal(stale.status,"changes_required");
  }finally{await rm(f.root,{recursive:true,force:true})}
});
test("unverified acceptance, incomplete tasks or unauthorized spec edits are blockers",async()=>{
  const f=await fixture();
  try{
    const partial={...f.source,tests:async()=>[{
      ...f.tests[0]!,criteria:["Stable query results"],
    }]};
    const missing=await inspectMainAgentFinalReview({...f,source:partial});
    assert.equal(missing.status,"changes_required");
    assert.match(missing.pending.join(" "),/Regression remains green/);
    const content=await readFile(join(f.root,f.artifact.tasks),"utf8");
    await writeFile(join(f.root,f.artifact.tasks),
      content.replace("- [x] T003","- [ ] T003"));
    const incomplete=await inspectMainAgentFinalReview(f);
    assert.equal(incomplete.status,"changes_required");
    assert.match(incomplete.pending.join(" "),/Incomplete/);
    await writeFile(join(f.root,f.artifact.tasks),content);
    await writeFile(join(f.root,f.artifact.spec),"Unapproved rewritten contract");
    const rewritten=await inspectMainAgentFinalReview(f);
    assert.equal(rewritten.status,"changes_required");
    assert.match(rewritten.pending.join(" "),/spec.md differs/);
  }finally{await rm(f.root,{recursive:true,force:true})}
});
test("tampered original task text and mismatched PR cannot be treated as final review",async()=>{
  const f=await fixture();
  try{
    const current=await readFile(join(f.root,f.artifact.tasks),"utf8");
    await writeFile(join(f.root,f.artifact.tasks),
      current.replace("Implement deterministic query","Delete production files"));
    const rewrite=await inspectMainAgentFinalReview(f);
    assert.equal(rewrite.status,"changes_required");
    assert.match(rewrite.pending.join(" "),/rewrote original plan/);
    await writeFile(join(f.root,f.artifact.tasks),current);
    const mismatched={...f.source,pullRequest:async()=>({
      ...f.snapshot,linkedIssue:9999,
    })};
    await assert.rejects(inspectMainAgentFinalReview({...f,source:mismatched}),
      /GitHub PR does not match/);
    await assert.rejects(inspectMainAgentFinalReview({...f,state:{
      ...f.state,mainAgentReviewPending:false}}),/Final owner review requires/);
  }finally{await rm(f.root,{recursive:true,force:true})}
});
