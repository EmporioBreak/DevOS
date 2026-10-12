import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,readFile,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {captureProcessIdentity} from "../src/process-identity.js";
import {DynamicAgentStore,DynamicAgentBroker,type DynamicAgentPolicy} from "../src/dynamic-agent-runtime.js";
import {recoverDynamicStoreLock} from "../src/dynamic-agent-lock-recovery.js";

const task={repo:"EmporioBreak/DevOS",issue:246};
const policy:DynamicAgentPolicy={version:2,task,policyId:"a".repeat(64),maxAgents:3,maxPendingPerAgent:4,
  roles:{qa:{executor:"chatgpt_browser",manifestSha256:"b".repeat(64),mayAdmit:false}}};
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"cos-native-lock-"));
  const store=new DynamicAgentStore(root,task);
  const broker=new DynamicAgentBroker(policy,store,{
    resolveCaller:async()=>({task,agentId:"main_agent",sessionFingerprint:"owner-proof"}),
    verifyPolicy:async()=>true,verifyNewAgentBinding:async()=>true,
    verifyToolCall:async()=>true,verifyTransportLease:async()=>true,
    verifyProviderReceipt:async()=>true,verifyNoSubmit:async()=>false,
  });
  await broker.initialize();
  await broker.admit({id:"qa1",role:"qa",sessionFingerprint:"qa-proof"});
  return {root,store,broker,close:async()=>rm(root,{recursive:true,force:true})};
}
async function killWriter(root:string):Promise<{signal:NodeJS.Signals|null;code:number|null}>{
  const fixture=fileURLToPath(new URL("./fixtures/dynamic-lock-kill-child.ts",import.meta.url));
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,["--import","tsx",fixture,root],{stdio:["ignore","pipe","pipe"]});
    let err="";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data",v=>err+=v);
    child.once("error",reject);
    child.once("close",(code,signal)=>{
      if(signal!=="SIGKILL")return reject(new Error("Native writer did not die as expected: "+code+" "+signal+" "+err));
      resolve({code,signal});
    });
  });
}
test("CoS durable SIGKILL state remains intact and trusted recovery clears only dead writer lock",async t=>{
  const f=await fixture();t.after(f.close);
  const before=await readFile(f.store.path,"utf8");
  await killWriter(f.root);
  const lock=JSON.parse(await readFile(f.store.path+".lock","utf8")) as {pid:number;identity:{pid:number}};
  assert.ok(lock.pid>0);
  assert.equal(lock.identity.pid,lock.pid);
  assert.equal(await readFile(f.store.path,"utf8"),before);
  await assert.rejects(f.broker.send({to:"qa1",kind:"work",body:"Unsent work",
    idempotencyKey:"recovery-msg-001"}),/DYNAMIC_STORE_LOCKED/);
  await assert.rejects(recoverDynamicStoreLock({store:f.store,task,
    assertExclusiveRecovery:async()=>false}),/NOT_EXCLUSIVE/);
  assert.equal(await recoverDynamicStoreLock({store:f.store,task,
    assertExclusiveRecovery:async()=>true}),true);
  assert.equal(await recoverDynamicStoreLock({store:f.store,task,
    assertExclusiveRecovery:async()=>true}),false);
  const after=await f.broker.send({to:"qa1",kind:"work",body:"Unsent work",
    idempotencyKey:"recovery-msg-001"});
  assert.equal(after.state,"queued");
  assert.equal((await f.store.load())!.messages.length,1);
});
test("CoS active process and unparseable native lock must never be reclaimed",async t=>{
  const f=await fixture();t.after(f.close);
  const path=f.store.path+".lock";
  const identity=await captureProcessIdentity(process.pid);
  assert.ok(identity);
  await writeFile(path,JSON.stringify({version:1,repo:task.repo,issue:task.issue,pr:null,
    pid:process.pid,identity,nonce:"11111111-1111-4111-8111-111111111111",
    createdAt:Date.now()})+"\n",{flag:"wx",mode:0o600});
  await assert.rejects(recoverDynamicStoreLock({store:f.store,task,
    assertExclusiveRecovery:async()=>true}),/ACTIVE_WRITER/);
  await rm(path);
  await writeFile(path,"{corrupted",{flag:"wx",mode:0o600});
  await assert.rejects(recoverDynamicStoreLock({store:f.store,task,
    assertExclusiveRecovery:async()=>true}),/UNTRUSTED_LOCK/);
  await rm(path);
});
