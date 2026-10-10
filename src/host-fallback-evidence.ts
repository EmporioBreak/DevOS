import {createHash,createHmac,randomUUID,timingSafeEqual} from "node:crypto";
import {lstat,readFile,mkdir,writeFile,link,rm} from "node:fs/promises";
import {dirname,join} from "node:path";
import type {TaskRef} from "./workflow.js";
import {JsonStateStore} from "./json-state-store.js";

type Identity=TaskRef&{workerId:string;turn:number};
type RecordProof={version:1;identity:Identity;sessionHash:string;tokenHash:string;
  reason:"desktop_commander_backend_unavailable";tool:string;at:string};
type SignedProof={proof:RecordProof;mac:string};
const H=/^[0-9a-f]{64}$/;
const W=/^[A-Za-z0-9_-]{1,100}$/;
const TOOL=/^[A-Za-z_][A-Za-z0-9_-]{0,100}$/;
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
function key(secret:string){
  if(Buffer.byteLength(secret)<32)throw new Error("Owner secret too short");
  return createHash("sha256").update("DevOS host fallback proof v1\0").update(secret).digest();
}
const mac=(proof:RecordProof,secret:string)=>createHmac("sha256",key(secret))
  .update(JSON.stringify(proof)).digest("hex");
function file(root:string,id:Identity){
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(id.repo)||
      !Number.isSafeInteger(id.issue)||id.issue<1||
      !W.test(id.workerId)||!Number.isSafeInteger(id.turn)||id.turn<0)
    throw new Error("Invalid host fallback task identity");
  return join(root,".devos","host-fallback-proofs",encodeURIComponent(id.repo),
    String(id.issue),`${id.workerId}-${id.turn}.json`);
}

/** Gateway-only: record an actually observed native Desktop Commander backend
 * outage while a verified worker grant is active. No worker-facing tool exists. */
export async function recordHostBackendUnavailable(root:string,secret:string,
  identity:Identity,session:string,tokenHash:string,tool:string):Promise<void>{
  if(!session.startsWith("https://chatgpt.com/")||!H.test(tokenHash)||!TOOL.test(tool))
    throw new Error("Invalid host fallback evidence");
  const path=file(root,identity);
  const proof:RecordProof={version:1,identity,sessionHash:sha(session),tokenHash,
    reason:"desktop_commander_backend_unavailable",tool,at:new Date().toISOString()};
  const bytes=JSON.stringify({proof,mac:mac(proof,secret)})+"\n";
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const directory=await lstat(dirname(path));
  if(!directory.isDirectory()||directory.isSymbolicLink()||
      (directory.mode&0o077)!==0)throw new Error("Insecure fallback proof directory");
  const temp=path+"."+randomUUID()+".tmp";
  try {
    await writeFile(temp,bytes,{flag:"wx",mode:0o600});
    try{await link(temp,path)}catch(error){
      if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
      // First genuine event wins. Never overwrite an existing receipt.
      if(!await verifyHostBackendUnavailable(root,secret,{...identity,sessionId:session,tokenHash}))
        throw new Error("Conflicting host fallback evidence");
    }
  }finally{await rm(temp,{force:true})}
}

export async function verifyHostBackendUnavailable(root:string,secret:string,
  requested:Identity&{sessionId:string;tokenHash:string},now=Date.now()):Promise<boolean>{
  try{
    if(!H.test(requested.tokenHash)||!requested.sessionId.startsWith("https://chatgpt.com/"))return false;
    const path=file(root,requested),stat=await lstat(path);
    const directory=await lstat(dirname(path));
    if(!directory.isDirectory()||directory.isSymbolicLink()||
        (directory.mode&0o077)!==0)return false;
    if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)return false;
    const {proof,mac:signature}=JSON.parse(await readFile(path,"utf8")) as SignedProof;
    if(!proof||proof.version!==1||!H.test(signature)||
        proof.reason!=="desktop_commander_backend_unavailable"||!TOOL.test(proof.tool)||
        JSON.stringify(proof.identity)!==JSON.stringify({repo:requested.repo,issue:requested.issue,
          workerId:requested.workerId,turn:requested.turn})||
        proof.sessionHash!==sha(requested.sessionId)||proof.tokenHash!==requested.tokenHash)return false;
    const at=Date.parse(proof.at);
    if(!Number.isFinite(at)||at>now||now-at>2*60*60_000)return false;
    const expected=mac(proof,secret);
    return timingSafeEqual(Buffer.from(expected,"hex"),Buffer.from(signature,"hex"));
  }catch{return false}
}

/** Gateway reads only its active signed task state; the model cannot supply
 * a session URL, task reference or turn token for this operation. */
export async function recordObservedHostOutage(root:string,secret:string,
  identity:Identity,tool:string):Promise<void>{
  const state=await new JsonStateStore(root,identity).load();
  if(state?.currentWorkerId!==identity.workerId||state.completedRuns!==identity.turn||
      state.mainAgentReviewPending||state.completionApproved||
      state.activeReport?.workerId!==identity.workerId||
      state.activeReport.turn!==identity.turn||
      !state.sessions[identity.workerId])return;
  await recordHostBackendUnavailable(root,secret,identity,
    state.sessions[identity.workerId]!,state.activeReport.tokenHash,tool);
}
