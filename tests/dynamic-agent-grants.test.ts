import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,rm,readFile,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {ChatWorkerProbeRegistry} from "../src/chat-worker-probe.js";
import {acquireTaskLock,taskLockPath} from "../src/task-lock.js";
import {DynamicAgentGrantRegistry} from "../src/dynamic-agent-grants.js";
import {DynamicAgentBroker,DynamicAgentStore,type DynamicAgentPolicy,
  type VerifiedDynamicCaller} from "../src/dynamic-agent-runtime.js";
import {sealDynamicAgentPolicy,sealedDynamicPolicyVerifier} from "../src/dynamic-agent-policy.js";

const task={repo:"EmporioBreak/DevOS",issue:246,pr:247};
const policy:DynamicAgentPolicy={version:2,task,policyId:"a".repeat(64),maxAgents:4,
  maxPendingPerAgent:6,roles:{qa:{executor:"chatgpt_browser",
    manifestSha256:"b".repeat(64),mayAdmit:true}}};
const secret="dynamic-registry-owner-secret-"+ "s".repeat(64);
const fp="chat_"+"c".repeat(64);
const chat="https://chatgpt.com/c/11b1ac35-1517-45fd-9333-c936b9c8a7a4";
const resourceUri="/devos/devos-tool/devos_worker_probe";
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"dynamic-v2-grants-"));
  let actor:VerifiedDynamicCaller={task,agentId:"main_agent",sessionFingerprint:"main-proof"};
  const store=new DynamicAgentStore(root,task);
  await sealDynamicAgentPolicy({root,policy,ownerSecret:secret,assertTrustedOwnerApproval:async()=>true});
  const taskLock=await acquireTaskLock(root,task);
  const broker=new DynamicAgentBroker(policy,store,{
    resolveCaller:async()=>actor,verifyPolicy:sealedDynamicPolicyVerifier(root,secret),
    verifyNewAgentBinding:async()=>true,verifyToolCall:async()=>true,
    verifyTransportLease:async()=>true,verifyProviderReceipt:async()=>true,verifyNoSubmit:async()=>false,
    verifyWakeLease:async()=>true,verifyWakeReceipt:async()=>true,
  });
  await broker.initialize();await broker.admit({id:"qa1",role:"qa",sessionFingerprint:fp});
  actor={task,agentId:"qa1",sessionFingerprint:fp};await broker.bindSession(chat);
  actor={task,agentId:"main_agent",sessionFingerprint:"main-proof"};
  const registry=new DynamicAgentGrantRegistry(root,secret);
  const probe=new ChatWorkerProbeRegistry(root,secret);
  async function bind(){
    const result=probe.issue(fp);
    if(result.status!=="issued")throw Error("probe unavailable");
    const providerMessage={author:{role:"tool",name:"api_tool.call_tool"},
      status:"finished_successfully",metadata:{invoked_resource:{resource_uri:resourceUri}},
      content:{content_type:"code",text:JSON.stringify({
        structuredContent:{status:"issued",nonce:result.nonce}
      })}};
    return registry.bindProvenMessage({task,agentId:"qa1",sessionId:chat,
      providerMessage,resourceUri,policy});
  }
  return {root,store,broker,registry,probe,bind,asQa:()=>actor={task,agentId:"qa1",sessionFingerprint:fp},
    asOwner:()=>actor={task,agentId:"main_agent",sessionFingerprint:"main-proof"},
    close:async()=>{await taskLock.release();await rm(root,{recursive:true,force:true})}};
}
test("real v2 grant needs exact provider-authored probe, signed policy and live owner",async t=>{
  const f=await fixture();t.after(f.close);
  assert.equal(await f.registry.resolveCaller(fp,policy),null);
  assert.equal(await f.bind(),true);
  assert.deepEqual(await f.registry.resolveCaller(fp,policy),
    {task,agentId:"qa1",sessionFingerprint:fp});
  assert.equal(await f.bind(),false,"second MCP fingerprint cannot grant same epoch");
  assert.equal(await f.registry.resolveCaller(fp,{...policy,policyId:"d".repeat(64)}),null);
});
test("finishing a v2 work unit immediately invalidates old worker grant even in same chat",async t=>{
  const f=await fixture();t.after(f.close);
  assert.equal(await f.bind(),true);
  f.asQa();
  await f.broker.finishWork({result:"QA cycle complete",idempotencyKey:"finish-grant-001"});
  assert.equal((await f.store.load())!.agents.find(a=>a.id==="qa1")?.grantEpoch,1);
  assert.equal(await f.registry.resolveCaller(fp,policy),null);
  assert.equal(await f.bind(),false,"sleeping worker can never mint a fresh active grant");
});
test("legacy v1 grants are not v2 authority; forged tool payloads never bind",async t=>{
  const f=await fixture();t.after(f.close);
  const nonce=f.probe.issue(fp);
  if(nonce.status!=="issued")throw Error("missing nonce");
  assert.equal(await f.registry.bindProvenMessage({task,agentId:"qa1",sessionId:chat,
    providerMessage:{author:{role:"assistant",name:"api_tool.call_tool"},
      status:"finished_successfully",metadata:{invoked_resource:{resource_uri:resourceUri}},
      content:{content_type:"code",text:JSON.stringify({status:"issued",nonce:nonce.nonce})}},
    resourceUri,policy}),false);
  assert.equal(await f.registry.resolveCaller(fp,policy),null);
});
test("v2 grants fail closed when native lock owner dies or task lock changes",async t=>{
  const f=await fixture();t.after(f.close);
  assert.equal(await f.bind(),true);
  const lockPath=taskLockPath(f.root,task);
  const lock=JSON.parse(await readFile(lockPath,"utf8"));
  lock.identity.startTime="unrelated-process";
  await writeFile(lockPath,JSON.stringify(lock)+"\n");
  assert.equal(await f.registry.resolveCaller(fp,policy),null);
});

test("COS saved QA conversation can receive a newly authenticated v2 grant after finish and wake",async t=>{
  const f=await fixture();t.after(f.close);
  assert.equal(await f.bind(),true);
  f.asQa();
  await f.broker.finishWork({result:"Original review finished",
    idempotencyKey:"grant-revive-finish-01"});
  assert.equal(await f.registry.resolveCaller(fp,policy),null);
  f.asOwner();
  await f.broker.send({to:"qa1",kind:"work",body:"Review the corrected PR",
    idempotencyKey:"grant-revive-message-01"});
  assert.equal((await f.store.load())!.agents.find(a=>a.id==="qa1")?.status,"waking");
  assert.equal(await f.bind(),false,"a page/tool probe alone cannot prove that revival happened");
  const wake=(await f.store.load())!.wakeCommands![0]!;
  const lease={task,commandId:wake.id,recipientId:wake.recipientId,
    conversationId:wake.conversationId,wakeKey:wake.wakeKey};
  await f.broker.claimWake(lease);
  await f.broker.confirmWake(lease,{...lease,providerMessageId:"real-provider-wake-id"});
  assert.equal(await f.bind(),true,"fresh proof after a confirmed wake restores worker authorization");
  assert.deepEqual(await f.registry.resolveCaller(fp,policy),
    {task,agentId:"qa1",sessionFingerprint:fp});
});
