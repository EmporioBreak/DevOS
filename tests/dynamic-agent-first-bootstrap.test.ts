import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {ChatWorkerProbeRegistry} from "../src/chat-worker-probe.js";
import {acquireTaskLock} from "../src/task-lock.js";
import {DynamicAgentBroker,DynamicAgentStore,type DynamicAgentPolicy} from "../src/dynamic-agent-runtime.js";
import {DynamicAgentGrantRegistry} from "../src/dynamic-agent-grants.js";
import {DynamicAgentBootstrapper} from "../src/dynamic-agent-bootstrap.js";
import {sealDynamicAgentPolicy,sealedDynamicPolicyVerifier} from "../src/dynamic-agent-policy.js";

const task={repo:"EmporioBreak/DevOS",issue:246,pr:247};
const policy:DynamicAgentPolicy={version:2,task,policyId:"d".repeat(64),maxAgents:4,
  maxPendingPerAgent:6,roles:{qa:{executor:"chatgpt_browser",manifestSha256:"c".repeat(64),mayAdmit:false}}};
const secret="host-owned-first-chat-bootstrap-secret-"+"z".repeat(64);
const chat="https://chatgpt.com/c/2fbe0c3a-c731-4218-aa65-3c8ae0951c7a";
const fingerprint="chat_"+"e".repeat(64),resourceUri="/devos/devos-tool/devos_worker_probe";
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"cos-first-chat-"));
  const lock=await acquireTaskLock(root,task);
  await sealDynamicAgentPolicy({root,policy,ownerSecret:secret});
  const store=new DynamicAgentStore(root,task);
  const broker=new DynamicAgentBroker(policy,store,{
    resolveCaller:async()=>({task,agentId:"main_agent",sessionFingerprint:"host-owner"}),
    verifyPolicy:sealedDynamicPolicyVerifier(root,secret),
    verifyNewAgentBinding:async proof=>proof.id==="qa-fresh" &&
      proof.sessionFingerprint===fingerprint && proof.sessionId===chat,
    verifySpawnLease:async lease=>lease.agentId==="qa-fresh"&&
      lease.idempotencyKey==="first-chat-0001"&&lease.task.repo===task.repo&&
      lease.task.issue===task.issue&&lease.task.pr===task.pr,
    verifyToolCall:async()=>false,verifyTransportLease:async()=>false,
    verifyProviderReceipt:async()=>false,verifyNoSubmit:async()=>false,
  });
  await broker.initialize();
  await broker.requestSpawn({id:"qa-fresh",role:"qa",brief:"E2E test QA",
    idempotencyKey:"first-chat-0001"});
  const lease={task,agentId:"qa-fresh",idempotencyKey:"first-chat-0001"};
  const probes=new ChatWorkerProbeRegistry(root,secret);
  const grants=new DynamicAgentGrantRegistry(root,secret);
  function proof(){
    const issued=probes.issue(fingerprint);
    if(issued.status!=="issued")throw Error("Cannot issue one-use probe");
    return {author:{role:"tool",name:"api_tool.call_tool"},
      status:"finished_successfully",metadata:{invoked_resource:{resource_uri:resourceUri}},
      content:{content_type:"code",text:JSON.stringify({
        structuredContent:{status:"issued",nonce:issued.nonce}
      })}};
  }
  const bind=(providerMessage:unknown,id="qa-fresh")=>
    grants.bindProvenMessage({task,agentId:id,sessionId:chat,
      providerMessage,resourceUri,policy});
  return {root,store,broker,lease,grants,proof,bind,
    close:async()=>{await lock.release();await rm(root,{recursive:true,force:true});}};
}
test("first authentic provider probe binds reserved new worker and grants first MCP turn",async t=>{
  const f=await fixture();t.after(f.close);
  assert.equal((await f.store.load())!.agents.length,1);
  await f.broker.claimSpawnBootstrap(f.lease);
  const proof=f.proof();
  assert.equal(await f.bind(proof),true);
  const state=(await f.store.load())!;
  assert.equal(state.pendingSpawns![0]!.state,"bound");
  assert.equal(state.agents.find(a=>a.id==="qa-fresh")!.sessionId,chat);
  assert.deepEqual(await f.grants.resolveCaller(fingerprint,policy),
    {task,agentId:"qa-fresh",sessionFingerprint:fingerprint});
  assert.equal(await f.bind(proof),false,"one-use challenge cannot issue another grant");
});
test("unclaimed or foreign bootstraps and forged assistant text cannot open v2 grant",async t=>{
  const f=await fixture();t.after(f.close);
  assert.equal(await f.bind(f.proof()),false);
  assert.equal((await f.store.load())!.pendingSpawns![0]!.state,"reserved");
  await f.broker.claimSpawnBootstrap(f.lease);
  assert.equal(await f.bind(f.proof(),"foreign-worker"),false);
  const fake={...f.proof(),author:{role:"assistant",name:"api_tool.call_tool"}};
  assert.equal(await f.bind(fake),false);
  assert.equal((await f.store.load())!.agents.length,1);
  assert.equal(await f.grants.resolveCaller(fingerprint,policy),null);
});
test("bootstrap returns same verified chat if observer already bound it; never reopens",async t=>{
  const f=await fixture();t.after(f.close);
  let opened=0;
  const bootstrapper=new DynamicAgentBootstrapper(policy,f.store,f.broker,{
    start:async()=>{
      opened++;
      assert.equal((await f.store.load())!.pendingSpawns![0]!.state,"bootstrap_uncertain");
      assert.equal(await f.bind(f.proof()),true);
      return {sessionId:chat,sessionFingerprint:fingerprint};
    }
  });
  assert.equal((await bootstrapper.bootstrap(f.lease)).sessionId,chat);
  await assert.rejects(bootstrapper.bootstrap(f.lease),/not reserved/);
  assert.equal(opened,1);
});
