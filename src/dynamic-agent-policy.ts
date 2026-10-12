import {createHash,createHmac,randomUUID,timingSafeEqual} from "node:crypto";
import {open,mkdir,readFile,realpath,lstat,link,rm} from "node:fs/promises";
import {dirname,join,resolve} from "node:path";
import type {TaskRef} from "./workflow.js";
import {validateDynamicPolicy,type DynamicAgentPolicy} from "./dynamic-agent-runtime.js";

interface SealedDynamicPolicy {
  version:1;
  policy:DynamicAgentPolicy;
  policySha256:string;
  mac:string;
}
const SHA=/^[a-f0-9]{64}$/;
/** Separate key domain from the immutable v1 Runner skill graph. */
function sign(record:Omit<SealedDynamicPolicy,"mac">,ownerSecret:string):string{
  if(Buffer.byteLength(ownerSecret)<32)
    throw new Error("Strong owner secret required for dynamic agent policy");
  const key=createHash("sha256").update("DevOS dynamic agent policy v2\0").update(ownerSecret).digest();
  return createHmac("sha256",key).update(JSON.stringify(record)).digest("hex");
}
function digest(policy:DynamicAgentPolicy):string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}
function sameTask(a:TaskRef,b:TaskRef):boolean{
  return a.repo===b.repo && a.issue===b.issue && (a.pr??null)===(b.pr??null);
}
export function dynamicPolicyPath(root:string,task:TaskRef):string{
  return join(root,".devos","dynamic","policies",
    encodeURIComponent(task.repo),`issue-${task.issue}.json`);
}
async function checkPath(path:string,writing:boolean):Promise<void>{
  const dir=dirname(path);
  if(writing)await mkdir(dir,{recursive:true,mode:0o700});
  if(await realpath(dir)!==resolve(dir))
    throw new Error("Dynamic policy directory cannot traverse a symlink");
  try{
    const st=await lstat(path);
    if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0||
      await realpath(path)!==resolve(path))
      throw new Error("Dynamic policy file is not private and regular");
  }catch(error){
    if(writing && (error as NodeJS.ErrnoException).code==="ENOENT")return;
    throw error;
  }
}
/**
 * Explicit trusted owner acceptance of one exact, task-scoped v2 policy.
 * This is a management-only host function, never exposed to workers/models.
 * The on-disk policy is immutable: no silent role/capability reconfiguration.
 */
export async function sealDynamicAgentPolicy(input:{
  root:string;policy:DynamicAgentPolicy;ownerSecret:string;
  assertTrustedOwnerApproval:(p:{task:TaskRef;policyId:string;sha256:string})=>Promise<boolean>;
}):Promise<string>{
  validateDynamicPolicy(input.policy);
  const policySha256=digest(input.policy);
  if(!await input.assertTrustedOwnerApproval({task:input.policy.task,
    policyId:input.policy.policyId,sha256:policySha256}))
    throw new Error("Exact owner approval required for this dynamic policy revision");
  const body:Omit<SealedDynamicPolicy,"mac">={
    version:1,policy:input.policy,policySha256
  };
  const text=JSON.stringify({...body,mac:sign(body,input.ownerSecret)})+"\n";
  const path=dynamicPolicyPath(input.root,input.policy.task);
  await checkPath(path,true);
  const temp=path+"."+randomUUID()+".tmp";
  const handle=await open(temp,"wx",0o600);
  try{
    await handle.writeFile(text,"utf8");
    await handle.sync();
  }finally{await handle.close();}
  try{
    try{await link(temp,path);}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
      await checkPath(path,false);
      if(await readFile(path,"utf8")!==text)
        throw new Error("Approved dynamic policy already sealed; no in-place capability change");
    }
    const parent=await open(dirname(path),"r");
    try{await parent.sync();}finally{await parent.close();}
  }finally{await rm(temp,{force:true});}
  return policySha256;
}
/** Fail closed for any change in repo, Issue, PR, sealed scope, roles or skills. */
export async function verifySealedDynamicAgentPolicy(input:{
  root:string;policy:DynamicAgentPolicy;ownerSecret:string
}):Promise<boolean>{
  validateDynamicPolicy(input.policy);
  const path=dynamicPolicyPath(input.root,input.policy.task);
  await checkPath(path,false);
  const parsed=JSON.parse(await readFile(path,"utf8")) as SealedDynamicPolicy;
  if(parsed?.version!==1||!parsed.policy||!SHA.test(parsed.policySha256)||
    !SHA.test(parsed.mac)||!sameTask(parsed.policy.task,input.policy.task))
    throw new Error("Dynamic policy signature or task binding missing");
  validateDynamicPolicy(parsed.policy);
  const sha=digest(input.policy);
  if(parsed.policySha256!==sha||digest(parsed.policy)!==sha)
    throw new Error("Dynamic policy revision differs from exact owner authorization");
  const expected=sign({version:1,policy:parsed.policy,policySha256:parsed.policySha256},
    input.ownerSecret);
  if(!timingSafeEqual(Buffer.from(expected,"hex"),Buffer.from(parsed.mac,"hex")))
    throw new Error("Dynamic policy owner MAC is invalid");
  return true;
}
/** Suitable for DynamicTrustBoundary.verifyPolicy, without side effects. */
export function sealedDynamicPolicyVerifier(root:string,ownerSecret:string){
  return async(policy:DynamicAgentPolicy):Promise<boolean>=>{
    try{return await verifySealedDynamicAgentPolicy({root,policy,ownerSecret});}
    catch{return false;}
  };
}

/** Read only an independently verified sealed policy, never model-provided roles. */
export async function readSealedDynamicAgentPolicy(input:{
  root:string;task:TaskRef;ownerSecret:string
}):Promise<DynamicAgentPolicy>{
  const path=dynamicPolicyPath(input.root,input.task);
  await checkPath(path,false);
  const raw=JSON.parse(await readFile(path,"utf8")) as SealedDynamicPolicy;
  if(raw?.version!==1||!raw.policy||!sameTask(raw.policy.task,input.task))
    throw new Error("Untrusted dynamic policy task selector");
  await verifySealedDynamicAgentPolicy({
    root:input.root,policy:raw.policy,ownerSecret:input.ownerSecret
  });
  return raw.policy;
}
