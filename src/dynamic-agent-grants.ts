import {createHash,createHmac,randomUUID,timingSafeEqual} from "node:crypto";
import {readFileSync,writeFileSync,lstatSync,mkdirSync,renameSync,unlinkSync,existsSync} from "node:fs";
import {join,dirname} from "node:path";
import {canonicalPrivateChatUrl} from "./chat-access.js";
import {ChatWorkerProbeRegistry,exactWorkerProbeResult} from "./chat-worker-probe.js";
import {taskLockPath} from "./task-lock.js";
import {captureProcessIdentity,sameProcessIdentity,type ProcessIdentity} from "./process-identity.js";
import {DynamicAgentStore,type DynamicAgentPolicy,type VerifiedDynamicCaller} from "./dynamic-agent-runtime.js";
import {verifySealedDynamicAgentPolicy} from "./dynamic-agent-policy.js";
import type {TaskRef} from "./workflow.js";

type Grant={ fingerprint:string;task:TaskRef;agentId:string;sessionId:string;
  grantEpoch:number;policyId:string;expiresAt:number };
interface GrantFile {version:2;entries:Grant[];mac:string}
const FINGERPRINT=/^chat_[a-f0-9]{64}$/;
const AGENT=/^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_GRANTS=128, TTL_MS=5*60_000;
function sameTask(a:TaskRef,b:TaskRef){
  return a.repo===b.repo&&a.issue===b.issue&&(a.pr??null)===(b.pr??null);
}
function isGrant(g:Grant):boolean{
  try{return FINGERPRINT.test(g.fingerprint)&&AGENT.test(g.agentId)&&
    g.agentId!=="main_agent"&&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(g.task.repo)&&
    Number.isSafeInteger(g.task.issue)&&g.task.issue>0&&
    (g.task.pr===undefined||(Number.isSafeInteger(g.task.pr)&&g.task.pr>0))&&
    canonicalPrivateChatUrl(g.sessionId)===g.sessionId&&
    Number.isSafeInteger(g.grantEpoch)&&g.grantEpoch>=0&&
    /^[a-f0-9]{64}$/.test(g.policyId)&&
    Number.isSafeInteger(g.expiresAt)&&g.expiresAt>0;
  }catch{return false;}
}
function ownerAlive(root:string,task:TaskRef):Promise<boolean>{
  return (async()=>{
    try{
      const path=taskLockPath(root,task),st=lstatSync(path);
      if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0)return false;
      const row=JSON.parse(readFileSync(path,"utf8")) as {
        repo:string;issue:number;pid:number;identity:ProcessIdentity;runId:string;
      };
      if(row.repo!==task.repo||row.issue!==task.issue||
        !Number.isSafeInteger(row.pid)||row.pid<=0||row.identity?.pid!==row.pid||
        !row.runId)return false;
      const actual=await captureProcessIdentity(row.pid);
      return !!actual&&sameProcessIdentity(actual,row.identity);
    }catch{return false;}
  })();
}
/**
 * COS exact-conversation caller identity mapped to DevOS server-authenticated
 * MCP fingerprint. V2 grants are a DISTINCT, owner-HMACed namespace from the
 * original immutable-graph v1 worker-grants.json. A v2 grant is never a Mac/
 * Desktop Commander permission: only the isolated agents v2 tool can consume it.
 */
export class DynamicAgentGrantRegistry {
  private readonly path:string;
  private readonly key:Buffer;
  constructor(private readonly root:string,private readonly secret:string){
    if(Buffer.byteLength(secret)<32)throw new Error("V2 grants require strong owner secret");
    this.path=join(root,".devos","dynamic","worker-grants-v2.json");
    this.key=createHash("sha256").update("DevOS dynamic worker grant v2\0").update(secret).digest();
  }
  private mac(entries:Grant[]):string{
    return createHmac("sha256",this.key).update("grants\0").update(JSON.stringify({version:2,entries})).digest("hex");
  }
  private read():Grant[]{
    if(!existsSync(this.path))return[];
    const st=lstatSync(this.path);
    if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o777)!==0o600||st.size>256*1024)
      throw new Error("Untrusted dynamic grant registry file");
    const data=JSON.parse(readFileSync(this.path,"utf8")) as GrantFile;
    if(data?.version!==2||!Array.isArray(data.entries)||data.entries.length>MAX_GRANTS||
      data.entries.some(g=>!isGrant(g))||
      new Set(data.entries.map(g=>g.fingerprint)).size!==data.entries.length||
      typeof data.mac!=="string"||!/^[a-f0-9]{64}$/.test(data.mac)||
      !timingSafeEqual(Buffer.from(data.mac,"hex"),Buffer.from(this.mac(data.entries),"hex")))
      throw new Error("Dynamic grant registry integrity failure");
    return data.entries;
  }
  private write(entries:Grant[]):void{
    if(entries.length>MAX_GRANTS)throw new Error("Dynamic grant budget exceeded");
    mkdirSync(dirname(this.path),{recursive:true,mode:0o700});
    // Fail closed on a concurrent writer; never last-writer-wins a permission.
    const claim=this.path+".writer";
    writeFileSync(claim,String(process.pid),{flag:"wx",mode:0o600});
    try{
      const tmp=this.path+"."+randomUUID()+".tmp";
      try{
        writeFileSync(tmp,JSON.stringify({version:2,entries,mac:this.mac(entries)})+"\n",
          {flag:"wx",mode:0o600});
        renameSync(tmp,this.path);
      }finally{try{unlinkSync(tmp)}catch{}}
    }finally{try{unlinkSync(claim)}catch{}}
  }
  private async live(grant:Grant,policy:DynamicAgentPolicy):Promise<boolean>{
    if(!sameTask(grant.task,policy.task)||grant.policyId!==policy.policyId||
      !await ownerAlive(this.root,grant.task))return false;
    try{
      if(!await verifySealedDynamicAgentPolicy({root:this.root,policy,ownerSecret:this.secret}))
        return false;
      const state=await new DynamicAgentStore(this.root,grant.task).load();
      if(!state||!sameTask(state.task,grant.task)||state.ownerDecision==="approved")return false;
      const agent=state.agents.find(a=>a.id===grant.agentId);
      const wakeAccepted=agent?.status!=="waking" ||
        state.wakeCommands?.some(cmd=>cmd.recipientId===grant.agentId&&
          cmd.conversationId===grant.sessionId&&cmd.state==="delivered"&&
          !!cmd.providerMessageId)===true;
      return !!agent&&wakeAccepted&&agent.executor==="chatgpt_browser"&&
        ["idle","busy","waking"].includes(agent.status)&&
        agent.sessionFingerprint===grant.fingerprint&&
        agent.sessionId===grant.sessionId&&
        (agent.grantEpoch??0)===grant.grantEpoch;
    }catch{return false;}
  }
  /**
   * Called exclusively by a host browser observer after an actual provider-
   * authored devos_worker_probe result in that exact saved worker conversation.
   * Neither nonce text nor a claimed URL from model arguments grants access.
   */
  async bindProvenMessage(input:{task:TaskRef;agentId:string;sessionId:string;
    providerMessage:unknown;resourceUri:string;policy:DynamicAgentPolicy;
  }):Promise<boolean>{
    if(!sameTask(input.task,input.policy.task)||!AGENT.test(input.agentId)||
      input.agentId==="main_agent")return false;
    const nonce=exactWorkerProbeResult(input.providerMessage,input.resourceUri);
    if(!nonce)return false;
    const probe=new ChatWorkerProbeRegistry(this.root,this.secret);
    // The one-use nonce is consumed only by the trusted local observation path.
    const fingerprint=probe.claim(nonce);
    if(!fingerprint)return false;
    const state=await new DynamicAgentStore(this.root,input.task).load().catch(()=>null);
    const agent=state?.agents.find(a=>a.id===input.agentId);
    if(!agent||agent.sessionId!==input.sessionId||
      agent.sessionFingerprint!==fingerprint)return false;
    const grant:Grant={fingerprint,task:input.task,agentId:input.agentId,
      sessionId:input.sessionId,grantEpoch:agent.grantEpoch??0,
      policyId:input.policy.policyId,expiresAt:Date.now()+TTL_MS};
    if(!isGrant(grant)||!await this.live(grant,input.policy))return false;
    try{
      const existing=this.read();
      const now=Date.now();
      // CoS revisits the SAME worker conversation after finish. Its previous
      // grant must be invalidated by the durable epoch, not pin the agent out
      // of all future revivals until a TTL expires.
      const collisions=existing.some(g=>g.expiresAt>now&&(
        (g.fingerprint===grant.fingerprint &&
          !(sameTask(g.task,grant.task)&&g.agentId===grant.agentId&&
            g.grantEpoch<grant.grantEpoch)) ||
        (sameTask(g.task,grant.task)&&g.agentId===grant.agentId&&
          g.grantEpoch===grant.grantEpoch)
      ));
      if(collisions)return false;
      this.write([...existing.filter(g=>g.expiresAt>now&&
        g.fingerprint!==grant.fingerprint),grant]);
      return true;
    }catch{return false;}
  }
  /**
   * A signed grant's task is only a *lookup hint*, never caller authority.
   * The host MUST subsequently resolveCaller with the exact sealed policy.
   */
  candidateTask(fingerprint:string|undefined,now=Date.now()):TaskRef|null {
    if(!fingerprint||!FINGERPRINT.test(fingerprint))return null;
    try{
      const entry=this.read().find(g=>g.fingerprint===fingerprint&&now<g.expiresAt);
      return entry?entry.task:null;
    }catch{return null;}
  }
  /** Invoke on every agents_v2 tool call using the real gateway MCP signal. */
  async resolveCaller(fingerprint:string|undefined,policy:DynamicAgentPolicy,
    now=Date.now()):Promise<VerifiedDynamicCaller|null>{
    if(!fingerprint||!FINGERPRINT.test(fingerprint))return null;
    try{
      const grants=this.read();
      const grant=grants.find(g=>g.fingerprint===fingerprint&&now<g.expiresAt);
      if(!grant||!await this.live(grant,policy))return null;
      return {task:grant.task,agentId:grant.agentId,sessionFingerprint:fingerprint};
    }catch{return null;}
  }
  revoke(task:TaskRef,agentId:string):void{
    const saved=this.read();
    this.write(saved.filter(g=>!(sameTask(g.task,task)&&g.agentId===agentId)));
  }
}
