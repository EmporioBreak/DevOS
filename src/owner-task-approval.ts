import {createHash, createHmac, randomBytes, randomUUID, timingSafeEqual} from "node:crypto";
import {existsSync, lstatSync, mkdirSync, readFileSync, linkSync, unlinkSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {ChatAccessRegistry} from "./chat-access.js";
import {ownerPassword} from "./chat-access-widget.js";
import type {TrustedApprovalVerifier} from "./main-agent-intake.js";

type Kind = "scope"|"spec"|"plan"|"constitution";
type Binding = {kind:Kind;digest:string};
export type OwnerTaskReview = {
  repo:string;issue:number;pr:number;gitSha:string;constitutionSha:string;
  approvals:Binding[];
};
type Pending = {fingerprint:string;review:OwnerTaskReview;expiresAt:number;attempts:number;receiptId?:string};
type Receipt = {version:1;id:string;fingerprint:string;review:OwnerTaskReview;createdAt:string};
type SignedReceipt = {receipt:Receipt;mac:string};
const H=/^[0-9a-f]{64}$/;
const COMMIT=/^[0-9a-f]{40}$/;
const TICKET=/^[A-Za-z0-9_-]{32}$/;
const ID=/^[0-9a-f-]{36}$/;
const TTL=5*60_000;
const MAX=128;
const key=(secret:string)=>createHash("sha256").update("DevOS exact owner approvals v1\0").update(secret).digest();
const canonical=(value:unknown):OwnerTaskReview=>{
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Invalid owner review");
  const x=value as OwnerTaskReview;
  if(Object.keys(x).sort().join()!=="approvals,constitutionSha,gitSha,issue,pr,repo"||
    typeof x.repo!=="string"|| !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(x.repo)||
    x.repo.includes("..")|| !Number.isSafeInteger(x.issue)||x.issue<1||
    !Number.isSafeInteger(x.pr)||x.pr<1||!COMMIT.test(x.gitSha)||
    !H.test(x.constitutionSha)||!Array.isArray(x.approvals)||
    x.approvals.length<1||x.approvals.length>12)throw new Error("Malformed owner review");
  for(const a of x.approvals){
    if(!a||typeof a!=="object"||Object.keys(a).sort().join()!=="digest,kind"||
      !["scope","spec","plan","constitution"].includes(a.kind)||!H.test(a.digest))
      throw new Error("Invalid approval binding");
  }
  if(new Set(x.approvals.map(a=>a.kind+":"+a.digest)).size!==x.approvals.length ||
    !x.approvals.some(a=>a.kind==="constitution"&&a.digest===x.constitutionSha))
    throw new Error("Constitution approval digest required");
  return structuredClone(x);
};
const fixedEqual=(a:string,b:string):boolean=>
  Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));

/** Only actual HTTPS password submission can create a receipt. Model-owned
 * requests issue a short-lived preview ticket, NEVER grant approval. */
export class OwnerTaskApprovalStore {
  private readonly pending=new Map<string,Pending>();
  private readonly passDigest:Buffer|undefined;
  private readonly signingKey:Buffer;
  private readonly dir:string;
  constructor(root:string,ownerSecret:string,private readonly chats:ChatAccessRegistry,passwordOverride?:string) {
    if(Buffer.byteLength(ownerSecret)<32)throw new Error("Owner signing secret too short");
    this.signingKey=key(ownerSecret);
    this.dir=join(root,".devos","owner-approvals");
    const password=ownerPassword(root,passwordOverride);
    this.passDigest=password?createHash("sha256").update(password).digest():undefined;
  }
  issue(fingerprint:string|undefined,input:unknown):{ready:boolean;reason?:string;ticket?:string;expires_in_seconds?:number}{
    if(!fingerprint||!this.chats.isApproved(fingerprint))return {ready:false,reason:"owner_chat_required"};
    if(!this.passDigest)return {ready:false,reason:"password_not_configured"};
    const review=canonical(input);
    const now=Date.now();
    for(const [t,p] of this.pending)if(p.expiresAt<=now)this.pending.delete(t);
    for(const [t,p] of this.pending)
      if(p.fingerprint===fingerprint&&!p.receiptId&&p.expiresAt>now)
        return JSON.stringify(p.review)===JSON.stringify(review)
          ? {ready:false,reason:"approval_pending",ticket:t,
              expires_in_seconds:Math.ceil((p.expiresAt-now)/1000)}
          : {ready:false,reason:"different_review_pending"};
    if(this.pending.size>=MAX)return {ready:false,reason:"capacity"};
    const ticket=randomBytes(24).toString("base64url");
    this.pending.set(ticket,{fingerprint,review,expiresAt:now+TTL,attempts:0});
    return {ready:true,ticket,expires_in_seconds:TTL/1000};
  }
  preview(ticket:unknown):OwnerTaskReview|null {
    if(typeof ticket!=="string"||!TICKET.test(ticket))return null;
    const p=this.pending.get(ticket);
    if(!p||p.expiresAt<=Date.now()||p.receiptId||p.attempts>=3||
       !this.chats.isApproved(p.fingerprint))return null;
    return structuredClone(p.review);
  }
  submit(value:unknown):boolean {
    if(!this.passDigest||!value||typeof value!=="object"||Array.isArray(value))return false;
    const x=value as Record<string,unknown>;
    if(Object.keys(x).sort().join()!=="confirm,password,ticket"||
       x.confirm!=="approve"||typeof x.password!=="string"||
       Buffer.byteLength(x.password)>1024||typeof x.ticket!=="string"||
       !TICKET.test(x.ticket))return false;
    const p=this.pending.get(x.ticket);
    if(!p||p.expiresAt<=Date.now()||p.receiptId||p.attempts>=3||
       !this.chats.isApproved(p.fingerprint))return false;
    p.attempts++;
    const candidate=createHash("sha256").update(x.password).digest();
    if(!timingSafeEqual(candidate,this.passDigest)){
      if(p.attempts>=3)this.pending.delete(x.ticket);
      return false;
    }
    // Do not allow a malformed/tampered local receipt to be replaced.
    const id=randomUUID();
    const receipt:Receipt={version:1,id,fingerprint:p.fingerprint,review:p.review,
      createdAt:new Date().toISOString()};
    const signed:SignedReceipt={receipt,mac:this.mac(receipt)};
    mkdirSync(this.dir,{recursive:true,mode:0o700});
    const directory=lstatSync(this.dir);
    if(!directory.isDirectory() || (directory.mode & 0o077)!==0)return false;
    const path=join(this.dir,id+".json"),temp=path+"."+randomUUID()+".tmp";
    try{
      writeFileSync(temp,JSON.stringify(signed)+"\n",{flag:"wx",mode:0o600});
      linkSync(temp,path);
      p.receiptId=id;
      return true;
    }catch{
      return false;
    }finally{
      try{unlinkSync(temp);}catch{}
    }
  }
  result(ticket:unknown,fingerprint:string|undefined):{approved:boolean;approval_ref?:string}{
    if(typeof ticket!=="string"||!TICKET.test(ticket)||!fingerprint)return {approved:false};
    const p=this.pending.get(ticket);
    if(!p||p.fingerprint!==fingerprint||!this.chats.isApproved(fingerprint)||
       !p.receiptId)return {approved:false};
    return {approved:true,approval_ref:"devos-owner-approval:"+p.receiptId};
  }
  private mac(receipt:Receipt):string {
    return createHmac("sha256",this.signingKey)
      .update(JSON.stringify(receipt)).digest("hex");
  }
  verify(reference:string,expected: {kind:string;digest:string},binding: {
    repo:string;issue:number;pr:number;constitutionSha:string;gitSha:string;
  }):boolean {
    if(!reference.startsWith("devos-owner-approval:"))return false;
    const id=reference.slice("devos-owner-approval:".length);
    if(!ID.test(id)||!H.test(expected.digest)||!H.test(binding.constitutionSha)||
       !COMMIT.test(binding.gitSha))return false;
    try{
      const directory=lstatSync(this.dir);
      if(!directory.isDirectory() || (directory.mode & 0o077)!==0)return false;
      const file=join(this.dir,id+".json");
      if(!existsSync(file))return false;
      const stat=lstatSync(file);
      if(!stat.isFile()||(stat.mode&0o077)!==0||stat.size>8192)return false;
      const signed=JSON.parse(readFileSync(file,"utf8")) as SignedReceipt;
      if(signed?.receipt?.id!==id||signed.receipt.version!==1||
         !H.test(signed.mac)||!fixedEqual(this.mac(signed.receipt),signed.mac))return false;
      const review=canonical(signed.receipt.review);
      if(review.repo!==binding.repo||review.issue!==binding.issue||
        review.pr!==binding.pr||review.gitSha!==binding.gitSha||
        review.constitutionSha!==binding.constitutionSha)return false;
      return review.approvals.some(a=>a.kind===expected.kind&&a.digest===expected.digest);
    }catch{return false;}
  }
}
/** Injected only by the local trusted Main Agent/host, never model input.
 * Approval refs are lookups, not assertions: disk HMAC is mandatory. */
export function trustedTaskApprovalVerifier(
  store:OwnerTaskApprovalStore,binding:{
    repo:string;issue:number;pr:number;constitutionSha:string;gitSha:string;
  }):TrustedApprovalVerifier{
  return async(evidence,expected)=>evidence.kind===expected.kind&&
    evidence.reviewedDigest===expected.digest&&
    store.verify(evidence.userMessageRef,expected,binding);
}
export const OWNER_TASK_APPROVAL_TOOL={
  name:"devos_owner_approval_request",
  title:"Request explicit owner approval for frozen DevOS task",
  description:"Owner-chat only. Creates a short-lived HTTPS review form for exact Issue/PR/Constitution/worker graph and skill roster digests. This tool NEVER approves the task; owner must inspect and enter the separate chat-access password directly in the form. Do not send passwords in chat.",
  inputSchema:{type:"object",properties:{
    repo:{type:"string"},issue:{type:"integer",minimum:1},pr:{type:"integer",minimum:1},
    gitSha:{type:"string"},constitutionSha:{type:"string"},
    approvals:{type:"array",items:{type:"object",properties:{
      kind:{type:"string",enum:["scope","spec","plan","constitution"]},
      digest:{type:"string"}},required:["kind","digest"],additionalProperties:false}},
  },required:["repo","issue","pr","gitSha","constitutionSha","approvals"],additionalProperties:false},
  annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  _meta:{securitySchemes:[{type:"oauth2",scopes:["mcp:tools"]}]},
} as const;
export const OWNER_TASK_APPROVAL_STATUS_TOOL={
  name:"devos_owner_approval_status",title:"Check exact owner approval receipt",
  description:"Owner-chat only. Returns a reference to a genuine owner-password-approved receipt, if submitted. The reference alone does not prove approval: the local Main Agent must cryptographically verify it against exact digests.",
  inputSchema:{type:"object",properties:{ticket:{type:"string"}},required:["ticket"],additionalProperties:false},
  annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  _meta:{securitySchemes:[{type:"oauth2",scopes:["mcp:tools"]}]},
} as const;

/** Safari / external-browser fallback: no credentials, query, or reviewer data in HTML. */
export function ownerTaskApprovalForm():string {
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8">'+
    '<meta name="viewport" content="width=device-width, initial-scale=1"></head>'+
    '<body style="font:16px system-ui;max-width:640px;margin:24px auto;padding:12px">'+
    '<h2>DevOS — утверждение конкретной задачи</h2>'+
    '<p>Проверьте задачу, PR, commit и все SHA-256 ниже. Это отдельное утверждение, а не доступ чата к Mac.</p>'+
    '<p><a id="pr" target="_blank" rel="noopener noreferrer">Открыть PR для сверки материалов</a></p>'+
    '<pre id="review" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>'+
    '<form id="approval" hidden><label>Пароль DevOS (не вводите его в ChatGPT): '+
    '<input id="password" type="password" autocomplete="off" required></label>'+
    '<button type="submit">Утверждаю точно указанные версии</button></form>'+
    '<p id="state" role="status"></p><script>"use strict";'+
    'const ticket=location.hash.slice(1);history.replaceState(null,"",location.pathname);'+
    'const state=document.getElementById("state"),form=document.getElementById("approval");'+
    'const display=document.getElementById("review");'+
    'const send=(path,body)=>fetch(path,{method:"POST",credentials:"omit",cache:"no-store",'+
    'referrerPolicy:"no-referrer",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});'+
    '(async()=>{try{const r=await send("/owner-approval/preview",{ticket});'+
    'if(!r.ok)throw Error("Недействительный или истёкший запрос");'+
    'const d=await r.json();document.getElementById("pr").href="https://github.com/"+d.repo+"/pull/"+d.pr;'+
    'display.textContent="GitHub: "+d.repo+" #"+d.issue+" / PR #"+d.pr+'+
    '"\\nCommit: "+d.gitSha+"\\nConstitution SHA: "+d.constitutionSha+'+
    '"\\n"+"Согласуемые точные SHA:\\n"+d.approvals.map(a=>a.kind+": "+a.digest).join("\\n");'+
    'form.hidden=false;}catch(e){state.textContent=String(e.message);}})();'+
    'form.addEventListener("submit",async e=>{e.preventDefault();form.hidden=true;'+
    'try{const password=document.getElementById("password").value;'+
    'document.getElementById("password").value="";'+
    'const r=await send("/owner-approval/submit",{ticket,password,confirm:"approve"});'+
    'state.textContent=r.ok?"DevOS: утверждение сохранено и подписано. Можно закрыть страницу.":'+
    '"Доступ отклонён или запрос истёк. Пароль не отправлен в ChatGPT.";}'+
    'catch{state.textContent="Ошибка связи, статус не подтверждён."}});'+
    '</script></body></html>';
}
