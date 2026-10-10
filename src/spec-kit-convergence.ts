import { createHash, randomUUID } from "node:crypto";
import { appendFile, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { resolve,relative,isAbsolute,sep } from "node:path";
import { intakeDigest, type IntakeContract } from "./main-agent-intake.js";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
const runGit=promisify(execFile);
import { preflightSkills,type SkillPreflightOptions } from "./skill-preflight.js";

export interface CanonicalTask{
  id:string;checked:boolean;text:string;
}
export interface ConvergenceGap{
  acceptance:string;description:string;
}
export interface TrustedConvergeReport{
  sourceRef:string;workerId:string;
  /** Trusted evidence that original implement ran on these exact tasks. */
  implementationRef:string;
  issue:number;pr:number;
  /** Independent review of actual code/tests and approved criteria. */
  gaps:ConvergenceGap[];
}
export type ConvergenceVerifier=(proof:TrustedConvergeReport,
  expected:{scopeDigest:string;gapDigest:string;issue:number;pr:number})=>Promise<boolean>;
export interface ConvergenceResult{
  status:"gaps_appended"|"unchanged"|"needs_implementation"|"final_review_required";
  newlyAdded:string[];
  taskFileHash:string;
  taskCount:number;
  /** Handoff is not owner approval. */
  ownerApproved:false;
}
const H=/^[a-f0-9]{64}$/;
const taskPattern=/^- \[([ xX])\] (T[0-9]{3,})\s+(.+)$/gm;
const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
function clean(s:unknown,label:string){
  if(typeof s!=="string" || !s.trim()||s.length>500 ||
    /[\r\n\0<>]/.test(s))throw new Error("Unsafe convergence "+label);
  return s.trim();
}
function marker(g:ConvergenceGap){
  return "DEVOS_GAP_"+sha(g.acceptance+"\0"+g.description).slice(0,24);
}
export function parseCanonicalTasks(content:string):CanonicalTask[]{
  const result:CanonicalTask[]=[];
  const existing=new Set<string>();
  for(const match of content.matchAll(taskPattern)){
    const id=match[2]!;
    if(existing.has(id))throw new Error("Duplicate original Spec Kit T-task ID");
    existing.add(id);result.push({id,checked:match[1]!==" ",text:match[3]!});
  }
  if(!result.length)throw new Error("Missing original Spec Kit actionable T-steps");
  const nums=result.map(x=>Number(x.id.slice(1)));
  if(nums.some((n,i)=>!Number.isSafeInteger(n) || i>0 && n<=nums[i-1]!))
    throw new Error("Original Spec Kit T-task IDs are not in dependency order");
  return result;
}
async function exactTasksPath(root:string,path:string):Promise<string>{
  const base=await realpath(root),actual=await realpath(resolve(base,path));
  const rel=relative(base,actual);
  if(!rel||rel===".."||rel.startsWith(".."+sep)||isAbsolute(rel) ||
    !(await stat(actual)).isFile())throw new Error("Canonical tasks path escapes task worktree");
  return actual;
}
/** A mechanical append-only gate; it does not execute implement or converge. */
export async function convergeSpecKitTasks(input:{
  root:string;approved:IntakeContract;
  issue:number;pr:number;
  expectedTasksSha256:string;
  proof:TrustedConvergeReport;
  verifyReport:ConvergenceVerifier;
  skillOptions:SkillPreflightOptions;
  /** Trusted owner-reviewed acceptance criteria from the frozen intake. */
}):Promise<ConvergenceResult> {
  if(!H.test(input.expectedTasksSha256) || !input.approved.artifacts ||
    input.approved.artifacts.scenario!=="feature"||
    input.approved.artifacts.task.issue!==input.issue ||
    !Number.isSafeInteger(input.pr)||input.pr<1)
    throw new Error("Convergence requires approved original feature, exact Issue/PR and tasks SHA");
  const report=input.proof;
  if(!report || !Array.isArray(report.gaps) ||
    report.gaps.length>40 || report.issue!==input.issue ||report.pr!==input.pr ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(report.workerId) ||
    !/^[A-Za-z0-9._:-]{6,120}$/.test(report.sourceRef) ||
    !/^[A-Za-z0-9._:-]{6,120}$/.test(report.implementationRef))
    throw new Error("Invalid reviewer convergence evidence");
  await preflightSkills({phase:"execution",role:"reviewer",selected:[],
    required:[],off:[],specKitStage:"converge"},input.skillOptions);
  const frozenDigest=intakeDigest(input.approved);
  const criteria=new Set(input.approved.acceptance);
  for(const gap of report.gaps){
    clean(gap.acceptance,"acceptance reference");
    clean(gap.description,"description");
    if(!criteria.has(gap.acceptance))
      throw new Error("Convergence tries to extend owner-approved scope");
  }
  const gapDigest=sha(JSON.stringify(report.gaps));
  if(!await input.verifyReport(report,{scopeDigest:frozenDigest,gapDigest,
    issue:input.issue,pr:input.pr}))
    throw new Error("Convergence review not independently verified");
  // Original Spec Kit requirements and plan stay at their owner-approved SHA.
  // tasks.md is allowed to be append-only after implementation begins.
  const contract=input.approved.artifacts;
  const tasksPath=contract.artifacts.tasks!;
  for(const file of [contract.artifacts.spec!,contract.artifacts.plan!]){
    const live=await readFile(await exactTasksPath(input.root,file));
    let old:Buffer;
    try{
      old=(await runGit("git",["-C",input.root,"show",
        contract.commit+":"+file],{encoding:"buffer",timeout:15000,
        maxBuffer:8*1024*1024})).stdout;
    }catch{throw new Error("Owner-approved original spec/plan Git SHA unavailable");}
    if(!live.equals(old))
      throw new Error("Owner-approved original spec/plan has changed since review");
  }
  const taskFile=await exactTasksPath(input.root,tasksPath);
  const lock=taskFile+".devos-converge.lock";
  let handle;
  try {handle=await open(lock,"wx",0o600);}
  catch(error) {
    if((error as NodeJS.ErrnoException).code==="EEXIST")
      throw new Error("Converge already running for canonical task file");
    throw error;
  }
  try {
    const before=await readFile(taskFile,"utf8");
    if(sha(before)!==input.expectedTasksSha256)
      throw new Error("Canonical tasks.md changed since trusted convergence review");
    const current=parseCanonicalTasks(before);
    if(report.gaps.length===0) {
      return {status:current.every(x=>x.checked)?"final_review_required":"needs_implementation",
        newlyAdded:[],taskFileHash:sha(before),taskCount:current.length,ownerApproved:false};
    }
    const extra=report.gaps.filter(g=>!before.includes("<!-- "+marker(g)+" -->"));
    if(!extra.length) {
      return {status:"unchanged",newlyAdded:[],taskFileHash:sha(before),
        taskCount:current.length,ownerApproved:false};
    }
    const nextId=Math.max(...current.map(x=>Number(x.id.slice(1))));
    const sections=Array.from(before.matchAll(/^## Phase\s+(\d+)\s*:/gm),
      x=>Number(x[1]));
    const phase=sections.length?Math.max(...sections)+1:1;
    const lines=extra.map((gap,i)=>"- [ ] T"+String(nextId+i+1).padStart(3,"0")+
      " [US1] "+gap.description+" (Acceptance: "+gap.acceptance+") "+
      "<!-- "+marker(gap)+" -->");
    const content=(before.endsWith("\n")?"\n":"\n\n")+
      "## Phase "+phase+": Convergence\n\n"+lines.join("\n")+"\n";
    await appendFile(taskFile,content,{encoding:"utf8"});
    const after=await readFile(taskFile,"utf8");
    if(!after.startsWith(before))throw new Error("Append-only invariant violated");
    parseCanonicalTasks(after);
    return {status:"gaps_appended",
      newlyAdded:extra.map((_,i)=>"T"+String(nextId+i+1).padStart(3,"0")),
      taskFileHash:sha(after),taskCount:current.length+extra.length,ownerApproved:false};
  } finally {
    await handle.close();
    await rm(lock,{force:true});
  }
}
