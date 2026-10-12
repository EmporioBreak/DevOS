import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {acquireTaskLock} from "../src/task-lock.js";
import {ChatWorkerProbeRegistry} from "../src/chat-worker-probe.js";
import {DynamicAgentBroker,DynamicAgentStore,type DynamicAgentPolicy,
  type VerifiedDynamicCaller} from "../src/dynamic-agent-runtime.js";
import {DynamicAgentGrantRegistry} from "../src/dynamic-agent-grants.js";
import {DynamicBrowserE2EHost} from "../src/dynamic-agent-browser-e2e-host.js";
import {sealDynamicAgentPolicy,sealedDynamicPolicyVerifier} from "../src/dynamic-agent-policy.js";

const task={repo:"EmporioBreak/DevOS",issue:246,pr:247};
const policy:DynamicAgentPolicy={version:2,task,policyId:"a".repeat(64),maxAgents:3,
  maxPendingPerAgent:8,roles:{
    qa:{executor:"chatgpt_browser",manifestSha256:"b".repeat(64),mayAdmit:false}
  }};
const secret="e2e-browser-only-native-owner-secret-"+"x".repeat(64);
const chat="https://chatgpt.com/c/60bb8cbf-2ecc-44b3-8cb1-9c1af4790c25";
const fp="chat_"+"e".repeat(64),uri="/devos/devos-tool/devos_worker_probe";
async function fixture(){
  const previous=process.env.DEVOS_DYNAMIC_AGENTS_V2;
  process.env.DEVOS_DYNAMIC_AGENTS_V2="enabled";
  const root=await mkdtemp(join(tmpdir(),"cos-first-browser-e2e-host-"));
  const lock=await acquireTaskLock(root,task);
  await sealDynamicAgentPolicy({root,policy,ownerSecret:secret});
  let caller:VerifiedDynamicCaller={task,agentId:"main_agent",sessionFingerprint:"host-owner"};
  const host=new DynamicBrowserE2EHost(root,policy,secret);
  const store=new DynamicAgentStore(root,task);
  const broker=new DynamicAgentBroker(policy,store,{
    resolveCaller:async()=>caller,verifyPolicy:sealedDynamicPolicyVerifier(root,secret),
    verifyNewAgentBinding:async proof=>proof.id==="qa1"&&proof.sessionFingerprint===fp&&proof.sessionId===chat,
    verifySpawnLease:async()=>true,verifyToolCall:async()=>true,
    verifyTransportLease:async()=>true,
    verifyProviderReceipt:async proof=>host.verifyMessageReceipt(proof),
    verifyWakeLease:async()=>true,verifyWakeReceipt:async proof=>host.verifyWakeReceipt(proof),
    verifyNoSubmit:async()=>false,
  });
  await broker.initialize();
  await broker.requestSpawn({id:"qa1",role:"qa",brief:"QA checks actual DevOS E2E",
    idempotencyKey:"e2e-first-qa-001"});
  const spawn={task,agentId:"qa1",idempotencyKey:"e2e-first-qa-001"};
  const grants=new DynamicAgentGrantRegistry(root,secret);
  const probes=new ChatWorkerProbeRegistry(root,secret);
  async function prove(){
    const p=probes.issue(fp);
    if(p.status!=="issued")throw Error("Cannot mint test challenge");
    return grants.bindProvenMessage({task,agentId:"qa1",sessionId:chat,
      providerMessage:{author:{role:"tool",name:"api_tool.call_tool"},
        status:"finished_successfully",metadata:{invoked_resource:{resource_uri:uri}},
        content:{content_type:"code",text:JSON.stringify({
          structuredContent:{status:"issued",nonce:p.nonce}
        })}},resourceUri:uri,policy});
  }
  return {root,store,broker,host,spawn,prove,grants,
    as:(id:string)=>caller={task,agentId:id,sessionFingerprint:id==="main_agent"?"host-owner":fp},
    close:async()=>{await lock.release();await rm(root,{recursive:true,force:true});
      if(previous===undefined)delete process.env.DEVOS_DYNAMIC_AGENTS_V2;
      else process.env.DEVOS_DYNAMIC_AGENTS_V2=previous;}
  };
}
test("first E2E browser host completes existing-chat grant, real-send proof and next wake without new profile",async t=>{
  const f=await fixture();t.after(f.close);
  await f.broker.claimSpawnBootstrap(f.spawn);
  const first=await f.host.prepareBootstrap({task,agentId:"qa1",role:"qa",
    brief:"QA checks actual DevOS E2E",executor:"chatgpt_browser",manifestSha256:"b".repeat(64)});
  assert.equal(first.sessionId,undefined);
  assert.equal(first.dynamicTurn?.mode,"bootstrap");
  assert.match(first.prompt,/devos_worker_probe/);
  assert.equal(first.prompt.includes(secret),false);
  assert.equal(await f.prove(),true);
  const id=await f.host.verifiedBootstrap({task,agentId:"qa1",role:"qa",
    executor:"chatgpt_browser",manifestSha256:"b".repeat(64),
    sessionId:chat,output:{text:"",sessionId:chat}});
  assert.equal(id,fp);
  f.as("main_agent");
  const message=await f.broker.send({to:"qa1",kind:"work",
    body:"Review the PR changes",idempotencyKey:"e2e-work-001"});
  const lease={task,recipientId:"qa1",messageId:message.id};
  await f.broker.claimForTransport(lease);
  const current=(await f.store.load())!.messages.find(m=>m.id===message.id)!;
  const request=await f.host.prepareMessage({task,recipient:{
    id:"qa1",executor:"chatgpt_browser",sessionId:chat},message:current});
  assert.equal(request.dynamicTurn?.mode,"work");
  assert.equal(request.sessionId,chat);
  assert.match(request.prompt,/Review the PR changes/);
  await request.onAcceptedUserMessage?.({sessionId:chat,providerMessageId:"provider-id-001"});
  const confirmed=await f.host.verifiedProviderMessage({task,workerId:"qa1",sessionId:chat,
    commandId:message.id,output:{text:"",sessionId:chat}});
  assert.equal(confirmed,"provider-id-001");
  await f.broker.confirmTransportDelivery(lease,{task,messageId:message.id,
    providerMessageId:confirmed!});
  f.as("qa1");
  await f.broker.finishWork({result:"QA pass needs one more check",
    idempotencyKey:"e2e-finish-001"});
  f.as("main_agent");
  const wakeMsg=await f.broker.send({to:"qa1",kind:"work",body:"Recheck again",
    idempotencyKey:"e2e-second-work"});
  const wake=(await f.store.load())!.wakeCommands![0]!;
  const wakeLease={task,recipientId:"qa1",conversationId:chat,
    commandId:wake.id,wakeKey:wake.wakeKey};
  await f.broker.claimWake(wakeLease);
  const wakeRequest=await f.host.prepareWake({task,recipientId:"qa1",conversationId:chat,
    executor:"chatgpt_browser",commandId:wake.id,wakeKey:wake.wakeKey,
    messages:[{id:wakeMsg.id,from:"main_agent",kind:"work",body:"Recheck again"}]});
  assert.equal(wakeRequest.sessionId,chat);
  assert.equal(wakeRequest.dynamicTurn?.startingGrantEpoch,1);
  await wakeRequest.onAcceptedUserMessage?.({sessionId:chat,providerMessageId:"provider-wake-002"});
  assert.equal(f.host.verifyWakeReceipt({...wakeLease,providerMessageId:"provider-wake-002"}),true);
  await f.broker.confirmWake(wakeLease,{...wakeLease,providerMessageId:"provider-wake-002"});
  assert.equal((await f.store.load())!.wakeCommands![0]!.state,"delivered");
});
test("first browser E2E host rejects wrong chat, unclaimed send, and unsealed Codex worker",async t=>{
  const f=await fixture();t.after(f.close);
  await assert.rejects(f.host.prepareBootstrap({task,agentId:"qa1",role:"qa",
    brief:"QA checks actual DevOS E2E",executor:"codex",manifestSha256:"b".repeat(64)}),
    /cannot impersonate Codex/);
  await assert.rejects(f.host.prepareMessage({task,recipient:{
    id:"qa1",executor:"chatgpt_browser",sessionId:chat},message:{
      id:"not-claimed",taskKey:"some",from:"main_agent",to:"qa1",kind:"work",
      body:"Fake",idempotencyKey:"wrong-work-001",state:"queued"
    }}),/no exact durable broker claim/);
  assert.equal(await f.host.verifiedProviderMessage({task,workerId:"qa1",sessionId:chat,
    commandId:"invented",output:{text:"done",sessionId:chat}}),null);
});
