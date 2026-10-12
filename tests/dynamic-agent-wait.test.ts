import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {acquireTaskLock} from "../src/task-lock.js";
import {ChatWorkerProbeRegistry} from "../src/chat-worker-probe.js";
import {DynamicAgentBroker,DynamicAgentStore,type DynamicAgentPolicy,
  type VerifiedDynamicCaller} from "../src/dynamic-agent-runtime.js";
import {DynamicAgentGrantRegistry} from "../src/dynamic-agent-grants.js";
import {sealDynamicAgentPolicy,sealedDynamicPolicyVerifier} from "../src/dynamic-agent-policy.js";
import {waitForDynamicBrowserTurn} from "../src/dynamic-agent-wait.js";

const task={repo:"EmporioBreak/DevOS",issue:246,pr:247};
const policy:DynamicAgentPolicy={version:2,task,policyId:"a".repeat(64),
  maxAgents:3,maxPendingPerAgent:8,roles:{
    qa:{executor:"chatgpt_browser",manifestSha256:"b".repeat(64),mayAdmit:false}
  }};
const secret="coS-first-end-to-end-test-secret-"+"w".repeat(64);
const fingerprint="chat_"+"c".repeat(64);
const chat="https://chatgpt.com/c/7a1228dd-c7d7-4a3c-91c1-590a2809ec4a";
const uri="/devos/devos-tool/devos_worker_probe";
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"dynamic-v2-wait-"));
  const lock=await acquireTaskLock(root,task);
  await sealDynamicAgentPolicy({root,policy,ownerSecret:secret});
  let actor:VerifiedDynamicCaller={task,agentId:"main_agent",sessionFingerprint:"owner"};
  const store=new DynamicAgentStore(root,task);
  const broker=new DynamicAgentBroker(policy,store,{
    resolveCaller:async()=>actor,
    verifyPolicy:sealedDynamicPolicyVerifier(root,secret),
    verifySpawnLease:async()=>true,
    verifyNewAgentBinding:async()=>true,verifyToolCall:async()=>true,
    verifyTransportLease:async()=>true,verifyProviderReceipt:async()=>true,
    verifyNoSubmit:async()=>false,
  });
  await broker.initialize();
  await broker.requestSpawn({id:"qa-new",role:"qa",brief:"E2E QA test",
    idempotencyKey:"qa-new-intent-1"});
  const lease={task,agentId:"qa-new",idempotencyKey:"qa-new-intent-1"};
  const grants=new DynamicAgentGrantRegistry(root,secret);
  const probes=new ChatWorkerProbeRegistry(root,secret);
  function proof(){
    const issued=probes.issue(fingerprint);
    if(issued.status!=="issued")throw Error("Missing probe");
    return {author:{role:"tool",name:"api_tool.call_tool"},status:"finished_successfully",
      metadata:{invoked_resource:{resource_uri:uri}},
      content:{content_type:"code",text:JSON.stringify({structuredContent:{
        status:"issued",nonce:issued.nonce}})}
    };
  }
  return {root,store,broker,grants,lease,proof,
    as:(id:string)=>actor={task,agentId:id,sessionFingerprint:id==="main_agent"?"owner":fingerprint},
    bind:async()=>grants.bindProvenMessage({task,agentId:"qa-new",sessionId:chat,
      providerMessage:proof(),resourceUri:uri,policy}),
    close:async()=>{await lock.release();await rm(root,{recursive:true,force:true})}};
}
test("real v2 completion waits for first verified grant, not just session URL",async t=>{
  const f=await fixture();t.after(f.close);
  const prior=process.env.DEVOS_DYNAMIC_AGENTS_V2;
  process.env.DEVOS_DYNAMIC_AGENTS_V2="enabled";
  t.after(()=>{if(prior===undefined)delete process.env.DEVOS_DYNAMIC_AGENTS_V2;
    else process.env.DEVOS_DYNAMIC_AGENTS_V2=prior;});
  await f.broker.claimSpawnBootstrap(f.lease);
  const controller=new AbortController();
  let finished=false;
  const pending=waitForDynamicBrowserTurn({root:f.root,
    turn:{task,agentId:"qa-new",mode:"bootstrap",startingGrantEpoch:0},
    expectedConversation:()=>chat,signal:controller.signal,maxWaitMs:1500,
    trustedSecret:secret,pollMs:25}).then(()=>finished=true);
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(finished,false,"unproven URL is not a registered worker");
  assert.equal(await f.bind(),true);
  await pending;
  assert.equal(finished,true);
});
test("v2 work completion needs fresh, current worker epoch instead of old finish",async t=>{
  const f=await fixture();t.after(f.close);
  const prior=process.env.DEVOS_DYNAMIC_AGENTS_V2;
  process.env.DEVOS_DYNAMIC_AGENTS_V2="enabled";
  t.after(()=>{if(prior===undefined)delete process.env.DEVOS_DYNAMIC_AGENTS_V2;
    else process.env.DEVOS_DYNAMIC_AGENTS_V2=prior;});
  await f.broker.claimSpawnBootstrap(f.lease);
  assert.equal(await f.bind(),true);
  const ctrl=new AbortController();
  const wait=waitForDynamicBrowserTurn({root:f.root,
    turn:{task,agentId:"qa-new",mode:"work",startingGrantEpoch:0},
    expectedConversation:()=>chat,signal:ctrl.signal,maxWaitMs:1600,
    trustedSecret:secret,pollMs:25});
  f.as("qa-new");
  await f.broker.finishWork({result:"QA finished current work",idempotencyKey:"qa-finish-0001"});
  await wait;
  const cancelled=new AbortController();
  const stale=waitForDynamicBrowserTurn({root:f.root,
    turn:{task,agentId:"qa-new",mode:"work",startingGrantEpoch:1},
    expectedConversation:()=>chat,signal:cancelled.signal,maxWaitMs:500,
    trustedSecret:secret,pollMs:25});
  cancelled.abort();
  await assert.rejects(stale,/aborted/);
});
test("wrong saved conversation is never accepted for first worker v2 bootstrap",async t=>{
  const f=await fixture();t.after(f.close);
  const prior=process.env.DEVOS_DYNAMIC_AGENTS_V2;
  process.env.DEVOS_DYNAMIC_AGENTS_V2="enabled";
  t.after(()=>{if(prior===undefined)delete process.env.DEVOS_DYNAMIC_AGENTS_V2;
    else process.env.DEVOS_DYNAMIC_AGENTS_V2=prior;});
  await f.broker.claimSpawnBootstrap(f.lease);
  assert.equal(await f.bind(),true);
  const ctrl=new AbortController();
  const pending=waitForDynamicBrowserTurn({root:f.root,
    turn:{task,agentId:"qa-new",mode:"bootstrap",startingGrantEpoch:0},
    expectedConversation:()=>"https://chatgpt.com/c/different-chat",
    signal:ctrl.signal,maxWaitMs:650,trustedSecret:secret,pollMs:25});
  await assert.rejects(pending,/deadline/);
});
