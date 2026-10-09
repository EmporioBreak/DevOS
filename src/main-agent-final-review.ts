import {readFile,realpath,stat} from "node:fs/promises";
import {relative,resolve,isAbsolute,sep} from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createHash} from "node:crypto";
import {validateIntakeContract,type IntakeContract} from "./main-agent-intake.js";
import {parseCanonicalTasks} from "./spec-kit-convergence.js";
import type {RunState} from "./orchestrator.js";

const git=promisify(execFile);
export interface OwnerPrSnapshot {
  repo:string;pr:number;headSha:string;state:"open"|"closed";
  linkedIssue:number;
  changedFiles:string[];
  reviewerStatus:"approved"|"changes_requested"|"missing";
  /** Trusted provider has linked a real independent reviewer report. */
  reviewRef:string|null;
}
export interface OwnerTestEvidence {
  id:string;headSha:string;
  command:string;passed:boolean;
  sourceRef:string;
  criteria:string[];
}
export interface MainAgentReviewSource {
  /** Live trusted GitHub/provider adapter, never LLM-authored evidence. */
  pullRequest(repo:string,pr:number):Promise<OwnerPrSnapshot>;
  /** Host/test-report backend confirms exact head and actual executed test. */
  tests(repo:string,pr:number):Promise<OwnerTestEvidence[]>;
  verifyTest(test:OwnerTestEvidence,headSha:string):Promise<boolean>;
  verifyReview(pr:OwnerPrSnapshot):Promise<boolean>;
}
export interface MainAgentReviewChecklist {
  status:"ready_for_main_agent_judgment"|"changes_required";
  task:{repo:string;issue:number;pr:number};
  headSha:string|null;
  pending:string[];
  acceptanceCovered:string[];
  completedTaskIds:string[];
  changedFileCount:number;
  workerReportsVerified:boolean;
  /** This module NEVER authorizes a final owner decision. */
  ownerApproved:false;
  releaseOrMergeAuthorized:false;
  humanProductReviewRequired:true;
}
const hex40=/^[0-9a-f]{40}$/;
const marker=/^- \[[ xX]\] T[0-9]{3,}/gm;
const normalizeChecklist=(v:string)=>v.replace(marker,
  x=>x.replace(/^(- )\[[ xX]\]/,"$1[ ]"));
async function committedFile(root:string,commit:string,path:string) {
  const out=await git("git",["-C",root,"show",commit+":"+path],{
    encoding:"buffer",timeout:15_000,maxBuffer:8*1024*1024,
  });
  return out.stdout as Buffer;
}
async function currentFile(root:string,path:string):Promise<Buffer>{
  const base=await realpath(root),file=await realpath(resolve(base,path));
  const diff=relative(base,file);
  if(!diff||diff===".."||diff.startsWith(".."+sep)||isAbsolute(diff) ||
      !(await stat(file)).isFile())
    throw new Error("Main Agent review artifact escapes approved worktree");
  return readFile(file);
}
/** Collects owner-checkable evidence; does NOT make a product judgment. */
export async function inspectMainAgentFinalReview(input:{
  root:string;approved:IntakeContract;
  state:RunState;source:MainAgentReviewSource;
}):Promise<MainAgentReviewChecklist> {
  const {root,state,source}=input;
  const approval=validateIntakeContract(input.approved);
  const artifact=approval.artifacts;
  if(!artifact||artifact.scenario!=="feature" ||
      !state.mainAgentReviewPending ||
      state.completionApproved===true ||
      state.task?.repo!==artifact.task.repo ||
      state.task.issue!==artifact.task.issue ||
      !Number.isSafeInteger(state.task.pr)||state.task.pr!<=0)
    throw new Error("Final owner review requires exact pending feature Issue and PR");
  const repo=state.task.repo,issue=state.task.issue,pr=state.task.pr!;
  const task={repo,issue,pr};
  const pending:string[]=[];
  const status=(headSha:string|null,covered:string[]=[],done:string[]=[],count=0,reviewed=false):
    MainAgentReviewChecklist=>({
      status:pending.length?"changes_required":"ready_for_main_agent_judgment",
      task,headSha,pending,acceptanceCovered:covered,
      completedTaskIds:done,changedFileCount:count,
      workerReportsVerified:reviewed,ownerApproved:false,
      releaseOrMergeAuthorized:false,humanProductReviewRequired:true,
    });
  const upstream=await Promise.all(["spec","plan","tasks"].map(key=>
    committedFile(root,artifact.commit,artifact.artifacts[key]!)));
  const current=await Promise.all(["spec","plan","tasks"].map(key=>
    currentFile(root,artifact.artifacts[key]!)));
  if(!upstream[0]!.equals(current[0]!))
    pending.push("Original owner-approved spec.md differs from recorded Git revision");
  if(!upstream[1]!.equals(current[1]!))
    pending.push("Original owner-approved plan.md differs from recorded Git revision");
  const plannedTasks=upstream[2]!.toString("utf8");
  const taskContent=current[2]!.toString("utf8");
  if(!normalizeChecklist(taskContent).startsWith(normalizeChecklist(plannedTasks)))
    pending.push("Canonical tasks.md rewrote original plan instead of append-only changes");
  const tasks=parseCanonicalTasks(taskContent);
  const done=tasks.filter(x=>x.checked).map(x=>x.id);
  if(done.length!==tasks.length)
    pending.push("Incomplete original/convergence T steps remain");
  const prData=await source.pullRequest(repo,pr);
  if(prData.repo!==repo||prData.pr!==pr||prData.linkedIssue!==issue||
      prData.state!=="open"||!hex40.test(prData.headSha)||
      !Array.isArray(prData.changedFiles)||
      new Set(prData.changedFiles).size!==prData.changedFiles.length)
    throw new Error("GitHub PR does not match signed owner task");
  const reviewed=prData.reviewerStatus==="approved" &&
    !!prData.reviewRef && await source.verifyReview(prData);
  if(!reviewed)pending.push("Independent reviewer has not verified the actual PR");
  const tests=await source.tests(repo,pr);
  if(!Array.isArray(tests)||!tests.length)pending.push("No actual test evidence on the PR head");
  const covered=new Set<string>(),ids=new Set<string>();
  for(const entry of tests){
    if(!entry||typeof entry.id!=="string"||!entry.id||
        ids.has(entry.id)||!hex40.test(entry.headSha)||
        !Array.isArray(entry.criteria)||typeof entry.command!=="string"||
        !entry.command.trim()||!entry.sourceRef)
      throw new Error("Invalid or repeated test evidence on Main Agent review");
    ids.add(entry.id);
    if(entry.headSha!==prData.headSha||!entry.passed ||
        !await source.verifyTest(entry,prData.headSha)) {
      pending.push("Missing passing independently verified test for "+entry.id);
      continue;
    }
    for(const criterion of entry.criteria){
      if(!approval.acceptance.includes(criterion))
        throw new Error("Test claims an unapproved acceptance criterion");
      covered.add(criterion);
    }
  }
  for(const criterion of approval.acceptance)
    if(!covered.has(criterion))pending.push("Missing evidence for acceptance: "+criterion);
  return status(prData.headSha,Array.from(covered),done,
    prData.changedFiles.length,reviewed);
}
