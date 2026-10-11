import {createHash,createHmac,randomUUID,timingSafeEqual} from "node:crypto";
import {lstat,mkdir,open,readFile,rename,rm,writeFile} from "node:fs/promises";
import {dirname,join} from "node:path";
import {canonicalChatApprovalReference} from "./chat-access.js";
import type {TaskRef} from "./workflow.js";

export type WakeupStatus="waiting"|"armed"|"ambiguous"|"confirmed"|"blocked";
interface WakeupRecord {
  version:1;
  task:{repo:string;issue:number};
  reviewRound:number;
  ownerFingerprint:string;
  referenceHash:string;
  promptHash:string;
  status:WakeupStatus;
  expiresAt:string;
  armedAt?:string;
  confirmedMessageHash?:string;
}
type SignedRecord={record:WakeupRecord;mac:string};
const HASH=/^[0-9a-f]{64}$/;
const OWNER=/^chat_[0-9a-f]{64}$/;
const REPO=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const hash=(text:string)=>createHash("sha256").update(text).digest("hex");

/** Owner wake-up queue, distinct from worker message sends.
 * A pending message is persisted before attempted delivery. Once armed, a
 * restart NEVER retries it without provider-authoritative read-only proof.
 * This module is not a sender and cannot claim a real notification was sent.
 */
export class OwnerWakeupLedger {
  private readonly signingKey:Buffer;
  constructor(private readonly root:string,ownerSecret:string){
    if(Buffer.byteLength(ownerSecret)<32)throw new Error("Strong owner wake-up signing secret required");
    this.signingKey=createHash("sha256").update("DevOS owner wake-up ledger v1\0")
      .update(ownerSecret).digest();
  }

  fileFor(task:TaskRef,reviewRound:number):string{
    if(!REPO.test(task.repo)||!Number.isSafeInteger(task.issue)||task.issue<1||
       !Number.isSafeInteger(reviewRound)||reviewRound<0)
      throw new Error("Invalid owner wake-up task or review round");
    return join(this.root,".devos","owner-wakeup",encodeURIComponent(task.repo),
      String(task.issue),String(reviewRound)+".json");
  }
  private mac(record:WakeupRecord):string{
    return createHmac("sha256",this.signingKey).update(JSON.stringify(record)).digest("hex");
  }
  private async read(task:TaskRef,round:number):Promise<WakeupRecord|null>{
    const path=this.fileFor(task,round);
    let stat;
    try{stat=await lstat(path);}
    catch(error){
      if((error as NodeJS.ErrnoException).code==="ENOENT")return null;
      throw error;
    }
    if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||
       stat.size>8192)throw new Error("Unsafe owner wake-up record");
    const signed=JSON.parse(await readFile(path,"utf8")) as SignedRecord;
    const rec=signed?.record;
    if(!rec||rec.version!==1||rec.task?.repo!==task.repo||
       rec.task.issue!==task.issue||rec.reviewRound!==round||
       !OWNER.test(rec.ownerFingerprint)||!HASH.test(rec.referenceHash)||
       !HASH.test(rec.promptHash)||!["waiting","armed","ambiguous","confirmed","blocked"].includes(rec.status)||
       !Number.isFinite(Date.parse(rec.expiresAt))||
       !HASH.test(signed.mac))
      throw new Error("Invalid owner wake-up ledger record");
    const expected=this.mac(rec);
    if(!timingSafeEqual(Buffer.from(expected,"hex"),Buffer.from(signed.mac,"hex")))
      throw new Error("Owner wake-up ledger MAC integrity check failed");
    return rec;
  }
  private async save(task:TaskRef,round:number,record:WakeupRecord):Promise<void>{
    const path=this.fileFor(task,round),temp=path+"."+randomUUID()+".tmp";
    try{
      await writeFile(temp,JSON.stringify({record,mac:this.mac(record)})+"\n",
        {flag:"wx",mode:0o600});
      await rename(temp,path);
    }finally{await rm(temp,{force:true});}
  }
  private async lock<T>(task:TaskRef,round:number,fn:()=>Promise<T>):Promise<T>{
    const path=this.fileFor(task,round),dir=dirname(path);
    await mkdir(dir,{recursive:true,mode:0o700});
    const stat=await lstat(dir);
    if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)
      throw new Error("Unsafe owner wake-up directory");
    const guard=path+".lock";
    let handle;
    try{handle=await open(guard,"wx",0o600);}
    catch{throw new Error("Concurrent or interrupted owner wake-up operation; fail closed")}
    try{return await fn();}
    finally{await handle.close();await rm(guard,{force:true});}
  }

  async status(task:TaskRef,reviewRound:number):Promise<WakeupStatus|null>{
    return (await this.read(task,reviewRound))?.status??null;
  }
  async enqueue(task:TaskRef,reviewRound:number,ownerFingerprint:string,
    approvedReference:string,message:string):Promise<WakeupStatus>{
    if(!OWNER.test(ownerFingerprint)||typeof message!=="string"||
       !message.trim()||message.length>16_000)
      throw new Error("Invalid exact owner wake-up intent");
    const ref=canonicalChatApprovalReference(approvedReference);
    const taskRef={repo:task.repo,issue:task.issue};
    return this.lock(task,reviewRound,async()=>{
      const prior=await this.read(task,reviewRound);
      const referenceHash=hash(ref),promptHash=hash(message);
      if(prior){
        if(prior.ownerFingerprint!==ownerFingerprint||
           prior.referenceHash!==referenceHash||prior.promptHash!==promptHash)
          throw new Error("Conflicting owner wake-up intent for the same review round");
        return prior.status;
      }
      const record:WakeupRecord={version:1,task:taskRef,reviewRound,
        ownerFingerprint,referenceHash,promptHash,status:"waiting",
        expiresAt:new Date(Date.now()+15*60_000).toISOString()};
      await this.save(task,reviewRound,record);
      return "waiting";
    });
  }

  /** Must be committed BEFORE the native sender clicks. A crash after this
   * call leaves the turn armed and not replayable on subsequent invocations. */
  async arm(task:TaskRef,reviewRound:number):Promise<boolean>{
    return this.lock(task,reviewRound,async()=>{
      const record=await this.read(task,reviewRound);
      if(!record)throw new Error("Missing owner wake-up intent");
      if(record.status!=="waiting")return false;
      if(Date.now()>=Date.parse(record.expiresAt)){
        await this.save(task,reviewRound,{...record,status:"blocked"});
        return false;
      }
      await this.save(task,reviewRound,{...record,status:"armed",armedAt:new Date().toISOString()});
      return true;
    });
  }
  async markAmbiguous(task:TaskRef,reviewRound:number):Promise<WakeupStatus>{
    return this.lock<WakeupStatus>(task,reviewRound,async()=>{
      const record=await this.read(task,reviewRound);
      if(!record||!["armed","ambiguous"].includes(record.status))
        throw new Error("Owner wake-up ambiguity requires an armed attempt");
      if(record.status==="armed")
        await this.save(task,reviewRound,{...record,status:"ambiguous"});
      return "ambiguous";
    });
  }

  /** Explicit cancellation is bounded and non-replayable. If the send was
   * already armed, cancellation means uncertainty, not proof it never sent. */
  async cancel(task:TaskRef,reviewRound:number):Promise<WakeupStatus>{
    return this.lock<WakeupStatus>(task,reviewRound,async()=>{
      const record=await this.read(task,reviewRound);
      if(!record)throw new Error("Missing owner wake-up intent");
      if(record.status==="waiting"){
        await this.save(task,reviewRound,{...record,status:"blocked"});
        return "blocked";
      }
      if(record.status==="armed"){
        await this.save(task,reviewRound,{...record,status:"ambiguous"});
        return "ambiguous";
      }
      return record.status;
    });
  }

  /** A host-injected verifier must independently match the real outgoing
   * provider user-message to this exact task/round/prompt/conversation.
   * Model text, a click return, or an apparent ChatGPT response is not proof.
   */
  async confirm(task:TaskRef,reviewRound:number,userMessageId:string,
    verifyProviderReceipt:(x:{task:TaskRef;reviewRound:number;
      promptHash:string;referenceHash:string;userMessageId:string})=>Promise<boolean>,
  ):Promise<WakeupStatus>{
    if(typeof userMessageId!=="string"||userMessageId.length<4||
       userMessageId.length>160||/\s/.test(userMessageId)||!verifyProviderReceipt)
      throw new Error("Invalid owner wake-up provider receipt");
    return this.lock<WakeupStatus>(task,reviewRound,async()=>{
      const record=await this.read(task,reviewRound);
      if(!record||!["armed","ambiguous","confirmed"].includes(record.status))
        throw new Error("Owner wake-up confirmation requires an armed attempt");
      const valid=await verifyProviderReceipt({task,reviewRound,promptHash:record.promptHash,
        referenceHash:record.referenceHash,userMessageId});
      if(!valid)throw new Error("Owner wake-up provider receipt was not independently verified");
      const messageHash=hash(userMessageId);
      if(record.status==="confirmed"){
        if(record.confirmedMessageHash!==messageHash)
          throw new Error("Conflicting provider receipt after confirmed wake-up");
        return "confirmed";
      }
      await this.save(task,reviewRound,{...record,status:"confirmed",
        confirmedMessageHash:messageHash});
      return "confirmed";
    });
  }
}
