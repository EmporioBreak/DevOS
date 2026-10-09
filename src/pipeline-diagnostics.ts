import {randomUUID} from "node:crypto";
import {mkdir,open,readFile,rename,rm,writeFile} from "node:fs/promises";
import {dirname,join} from "node:path";
import {JsonStateStore} from "./json-state-store.js";
import {readWorkerSkillManifest} from "./skill-policy.js";
import type {OrchestrationEvent} from "./orchestrator.js";
import type {TaskRef} from "./workflow.js";

const REPO=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKER=/^[A-Za-z0-9_-]{1,100}$/;
const STATUSES=new Set(["ready","running","final_review_required",
  "changes_requested","completed","blocked","failed"]);
const TYPE=new Set(["task_status","worker_started","worker_result",
  "transition","worker_session_recovered","main_agent_handoff"]);
const MAX_RECORDS=150, MAX_FILE_BYTES=128*1024;
export interface TaskAuditRecord{
  version:1;
  at:string;event:"task_status"|"worker_started"|"worker_result"|
    "transition"|"worker_session_recovered"|"main_agent_handoff";
  task:{repo:string;issue:number;pr?:number};
  workerId?:string;
  from?:string;to?:string;
  status?:string;
  executor?:string;session?:string;
  /** A fixed category, NEVER a raw host error or private identifier. */
  reason?:string;
}
const allowedReason=(reason:string)=>{
  if(/saved Codex session belongs to a different project root/i.test(reason))
    return "codex_worktree_mismatch";
  if(/browser|conversation|session|project/i.test(reason))
    return "browser_session_recovery";
  if(/codex|thread/i.test(reason))return "codex_session_recovery";
  return "recovering_opaque_session";
};
function validTask(task:TaskRef){
  if(!REPO.test(task.repo)||!Number.isSafeInteger(task.issue)||task.issue<=0||
    task.pr!==undefined&&(!Number.isSafeInteger(task.pr)||task.pr<=0))
    throw new Error("Invalid task audit identity");
}
const AUDIT_FIELDS=new Set(["version","at","event","task","workerId",
  "from","to","status","executor","session","reason"]);
function checkAuditLine(line:string,task:TaskRef):TaskAuditRecord{
  const obj:unknown=JSON.parse(line);
  if(!obj||typeof obj!=="object"||Array.isArray(obj))
    throw new Error("Malformed persisted DevOS audit event");
  const rec=obj as Record<string,unknown>;
  const t=rec.task;
  if(rec.version!==1||!TYPE.has(String(rec.event))||
    Object.keys(t as Record<string,unknown>).some(k=>!["repo","issue","pr"].includes(k))||
    ((t as {pr?:unknown}).pr!==undefined && (!Number.isSafeInteger((t as {pr:number}).pr)||
       (t as {pr:number}).pr<=0))||
    Object.keys(rec).some(x=>!AUDIT_FIELDS.has(x))||
    !t||typeof t!=="object"||Array.isArray(t)||
    (t as {repo?:unknown}).repo!==task.repo ||
    (t as {issue?:unknown}).issue!==task.issue ||
    !Number.isFinite(Date.parse(String(rec.at)))||
    rec.workerId!==undefined&&!WORKER.test(String(rec.workerId))||
    rec.from!==undefined&&!WORKER.test(String(rec.from))||
    rec.to!==undefined&&!WORKER.test(String(rec.to))||
    rec.status!==undefined&&!new Set([...STATUSES,"done","approved",
      "needs_local_worker"]).has(String(rec.status))||
    rec.executor!==undefined&&!["codex","chatgpt_browser"].includes(String(rec.executor))||
    rec.session!==undefined&&!["fresh","resumed"].includes(String(rec.session))||
    rec.reason!==undefined&&!["codex_worktree_mismatch","browser_session_recovery",
      "codex_session_recovery","recovering_opaque_session"].includes(String(rec.reason)))
    throw new Error("Invalid or unsafe persisted DevOS audit entry");
  return obj as TaskAuditRecord;
}
const pathFor=(root:string,task:TaskRef)=>join(root,".devos","logs","timeline",
  encodeURIComponent(task.repo)+"-issue-"+task.issue+".jsonl");
function normalized(task:TaskRef,event:OrchestrationEvent,at:string):TaskAuditRecord {
  validTask(task);
  const record:TaskAuditRecord={version:1,at,event:event.type,
    task:{repo:task.repo,issue:task.issue,...(task.pr?{pr:task.pr}:{})}};
  if(event.type==="task_status") {
    if(!STATUSES.has(event.status))throw new Error("Invalid task audit lifecycle");
    record.status=event.status;
  }
  if(event.type==="worker_started"||event.type==="worker_result") {
    if(!WORKER.test(event.workerId))throw new Error("Invalid task audit worker");
    record.workerId=event.workerId;record.executor=event.executor;
    record.status=event.type==="worker_started"?"running":event.status;
    if(event.type==="worker_started")record.session=event.session;
  }
  if(event.type==="transition") {
    record.from=WORKER.test(event.from)?event.from:"orchestrator";
    record.to=WORKER.test(event.to)?event.to:"orchestrator";
  }
  if(event.type==="worker_session_recovered") {
    if(!WORKER.test(event.workerId))throw new Error("Invalid recovery worker");
    record.workerId=event.workerId;
    record.executor=event.executor;
    record.reason=allowedReason(event.reason);
  }
  return record;
}
/** Durable bounded per-Issue journal; no raw prompt, session URL, token or secret. */
export async function appendTaskAuditEvent(
  root:string,task:TaskRef,event:OrchestrationEvent,
  at=new Date().toISOString(),
):Promise<void>{
  if(!Number.isFinite(Date.parse(at)))throw new Error("Invalid audit timestamp");
  const path=pathFor(root,task);
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  // Exclusive brief lock makes append safe for multiple task-status readers/writers.
  const lock=path+".lock";
  let handle;
  try{handle=await open(lock,"wx",0o600);}
  catch(error){
    if((error as NodeJS.ErrnoException).code==="EEXIST")
      throw new Error("Task timeline audit append already in progress");
    throw error;
  }
  try {
    let lines:string[]=[];
    try{lines=(await readFile(path,"utf8")).split("\n").filter(Boolean);}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    const next=JSON.stringify(normalized(task,event,at));
    lines.push(next);
    lines=lines.slice(-MAX_RECORDS);
    while(lines.join("\n").length>MAX_FILE_BYTES && lines.length>1)lines.shift();
    const temp=path+"."+randomUUID()+".tmp";
    try{await writeFile(temp,lines.join("\n")+"\n",{flag:"wx",mode:0o600});
      await rename(temp,path);
    }finally{await rm(temp,{force:true})}
  }finally{await handle.close();await rm(lock,{force:true})}
}
export interface PipelineSnapshot{
  version:1;
  task:{repo:string;issue:number;pr?:number};
  state:"not_started"|"running"|"final_review_required"|"completed"|"unverified";
  workerId:string|null;
  turn:number;reviewLoops:number;
  workers:Array<{workerId:string;role:string;stage:string|null;
    assignment:"verified"|"missing"|"invalid"|"unverified";
    selected:Array<{id:string;version:string;mode:string;why:string}>;
    skipped:Array<{id:string;why:string}>;}>;
  events:TaskAuditRecord[];
  blocker:string|null;
}
function safeSkip(reason:string){
  if(/^off at (global|project|role|task) scope$/.test(reason))return reason;
  if(reason==="not registered in Skills Library")return reason;
  if(/conflict/i.test(reason))return "Incompatible optional skill";
  if(/not available|missing|ENOENT/i.test(reason))return "Pinned resource unavailable";
  return "Optional skill omitted after preflight";
}
export async function readPipelineSnapshot(
  root:string,task:TaskRef,ownerSecret?:string,
):Promise<PipelineSnapshot>{
  validTask(task);
  const state=await new JsonStateStore(root,task).load();
  let events:TaskAuditRecord[]=[];
  try{
    const text=await readFile(pathFor(root,task),"utf8");
    events=text.split("\n").filter(Boolean).slice(-MAX_RECORDS).map(line=>
      checkAuditLine(line,task));
  }catch(error){
    if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
  }
  const known=new Set<string>();
  for(const record of events)if(record.workerId)known.add(record.workerId);
  if(state?.currentWorkerId) {
    if(!WORKER.test(state.currentWorkerId))
      throw new Error("Unsafe worker identity in persisted task state");
    known.add(state.currentWorkerId);
  }
  const workers:PipelineSnapshot["workers"]=[];
  for(const id of [...known].sort()){
    let assignment:PipelineSnapshot["workers"][number]["assignment"]=ownerSecret?"missing":"unverified";
    let role="unknown",stage:string|null=null;
    let selected:PipelineSnapshot["workers"][number]["selected"]=[],skipped:
      PipelineSnapshot["workers"][number]["skipped"]=[];
    if(ownerSecret){
      try{
        const manifest=await readWorkerSkillManifest(root,task,id,ownerSecret);
        assignment="verified";role=manifest.role;stage=manifest.specKitStage;
        selected=manifest.selected.map(x=>({id:x.id,version:x.version,
          mode:x.mode,why:x.rule}));
        skipped=manifest.skipped.map(x=>({id:x.skillId,why:safeSkip(x.reason)}));
      }catch(error){
        assignment=(error as NodeJS.ErrnoException).code==="ENOENT"?"missing":"invalid";
      }
    }
    workers.push({workerId:id,role,stage,assignment,selected,skipped});
  }
  const derived:PipelineSnapshot["state"]=state?.completionApproved?"completed":
    state?.mainAgentReviewPending?"final_review_required":
    state?"running":events.some(x=>x.status==="completed")?"completed":"not_started";
  const blocker=state?.activeReport&&state.browserWorkersStarted?.includes(state.currentWorkerId)
    ?"Unresolved active browser turn: use authenticated worker report or inspect saved chat"
    :workers.some(x=>x.assignment==="invalid")
      ?"A signed worker skill assignment failed verification":null;
  return {version:1,task:{repo:task.repo,issue:task.issue,...(task.pr?{pr:task.pr}:{})},
    state:derived,workerId:state?.currentWorkerId??null,
    turn:state?.completedRuns??0,reviewLoops:state?.reviewLoops??0,
    workers,events,blocker};
}
