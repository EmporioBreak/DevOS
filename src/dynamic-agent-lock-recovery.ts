import {lstat,readFile,rm} from "node:fs/promises";
import {captureProcessIdentity,sameProcessIdentity,type ProcessIdentity} from "./process-identity.js";
import type {TaskRef} from "./workflow.js";
import {DynamicAgentStore} from "./dynamic-agent-runtime.js";

interface NativeWriterLock {
  version:1;
  repo:string;
  issue:number;
  pr:number|null;
  pid:number;
  identity:ProcessIdentity;
  nonce:string;
  createdAt:number;
}
const noncePattern=/^[a-f0-9-]{36}$/i;

/**
 * Host-controlled recovery after a crashed owner, modeled on CoS's rule that
 * no durable command can be replayed merely because its process died.
 *
 * MUST be called only after an independent coordinator has fenced admission
 * and all other writers for this task. Not an MCP/model-accessible operation.
 * Concurrent independent reclaimers without the exclusive coordinator are
 * unsupported and must fail closed at the coordinator boundary.
 */
export async function recoverDynamicStoreLock(input:{
  store:DynamicAgentStore;
  task:TaskRef;
  /** Must be true only after the trusted host has exclusive maintenance rights. */
  assertExclusiveRecovery:()=>Promise<boolean>;
}):Promise<boolean>{
  if(!await input.assertExclusiveRecovery())
    throw new Error("DYNAMIC_RECOVERY_NOT_EXCLUSIVE: task writer still available");
  const path=input.store.path+".lock";
  let originalStat;
  try{originalStat=await lstat(path);}
  catch(error){
    if((error as NodeJS.ErrnoException).code==="ENOENT")return false;
    throw error;
  }
  if(!originalStat.isFile() || originalStat.isSymbolicLink() ||
    (originalStat.mode&0o077)!==0)
    throw new Error("DYNAMIC_RECOVERY_UNTRUSTED_LOCK: unsafe file mode or symlink");
  let raw:string,lock:NativeWriterLock;
  try{
    raw=await readFile(path,"utf8");
    lock=JSON.parse(raw) as NativeWriterLock;
  }catch{
    throw new Error("DYNAMIC_RECOVERY_UNTRUSTED_LOCK: incomplete or malformed writer proof");
  }
  if(lock.version!==1||lock.repo!==input.task.repo||
    lock.issue!==input.task.issue||(lock.pr??null)!==(input.task.pr??null)||
    !Number.isSafeInteger(lock.pid)||lock.pid<=0||lock.identity?.pid!==lock.pid||
    typeof lock.identity?.startTime!=="string"||
    typeof lock.identity?.executable!=="string"||
    typeof lock.identity?.commandLine!=="string"||
    typeof lock.nonce!=="string"||!noncePattern.test(lock.nonce)||
    !Number.isSafeInteger(lock.createdAt)||lock.createdAt<=0)
    throw new Error("DYNAMIC_RECOVERY_UNTRUSTED_LOCK: invalid owner identity or task");
  let processAlive=false;
  try{process.kill(lock.pid,0);processAlive=true;}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=="ESRCH")
      throw new Error("DYNAMIC_RECOVERY_UNCERTAIN_OWNER: cannot prove the owner died");
  }
  if(processAlive){
    const actual=await captureProcessIdentity(lock.pid);
    if(!actual)
      throw new Error("DYNAMIC_RECOVERY_UNCERTAIN_OWNER: process identity unavailable");
    if(sameProcessIdentity(lock.identity,actual))
      throw new Error("DYNAMIC_RECOVERY_ACTIVE_WRITER: original task writer is still alive");
    // PID reuse: a different, independently identified process cannot own
    // this previously written lock. Host exclusivity remains mandatory.
  }
  if(!await input.assertExclusiveRecovery())
    throw new Error("DYNAMIC_RECOVERY_NOT_EXCLUSIVE: owner changed during recovery");
  const after=await lstat(path);
  if(after.ino!==originalStat.ino||after.dev!==originalStat.dev||
    after.size!==originalStat.size||await readFile(path,"utf8")!==raw)
    throw new Error("DYNAMIC_RECOVERY_LOCK_CHANGED: refusing to reclaim new writer");
  await rm(path);
  // No browser send, Codex turn or accepted message is replayed here.
  return true;
}
