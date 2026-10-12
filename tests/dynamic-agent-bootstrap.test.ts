import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {DynamicAgentBroker, DynamicAgentStore, type DynamicAgentPolicy} from "../src/dynamic-agent-runtime.js";
import {DynamicAgentBootstrapper} from "../src/dynamic-agent-bootstrap.js";

const task={repo:"EmporioBreak/DevOS",issue:246,pr:247};
const pin="c".repeat(64);
const policy:DynamicAgentPolicy={version:2,task,policyId:"b".repeat(64),maxAgents:5,
  maxPendingPerAgent:10,roles:{
    qa:{executor:"chatgpt_browser",manifestSha256:pin,mayAdmit:true},
    security:{executor:"codex",manifestSha256:"d".repeat(64),mayAdmit:false}
  }};
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"coS-spawn-bootstrap-"));
  let allow=true;
  const store=new DynamicAgentStore(root,task);
  const trust={
    resolveCaller:async()=>({task,agentId:"main_agent",sessionFingerprint:"owner"}),
    verifyPolicy:async()=>true,verifyToolCall:async()=>true,
    verifyNewAgentBinding:async(input:{id:string;role:string;sessionFingerprint:string;sessionId?:string})=>
      allow && input.id==="qa-new" && input.role==="qa" &&
      input.sessionFingerprint==="verified-new-chat" &&
      input.sessionId==="https://chatgpt.com/c/new-real-chat",
    verifyTransportLease:async()=>true,verifyProviderReceipt:async()=>true,verifyNoSubmit:async()=>false,
    verifySpawnLease:async()=>true,verifySpawnNoStart:async()=>false,
  };
  const broker=new DynamicAgentBroker(policy,store,trust);
  await broker.initialize();
  const input={id:"qa-new",role:"qa",brief:"Test the original Issue acceptance.",
    idempotencyKey:"spawn-intent-0001"};
  await broker.requestSpawn(input);
  const lease={task,agentId:input.id,idempotencyKey:input.idempotencyKey};
  return {root,broker,store,lease,denyBinding:()=>allow=false,close:async()=>rm(root,{recursive:true,force:true})};
}
test("CoS staged worker bootstrap creates one session only AFTER accepted durable reservation",async t=>{
  const f=await fixture();t.after(f.close);
  const called:Array<{role:string;brief:string;manifestSha256:string;agentId:string}>=[];
  const adapter={start:async(input:{role:string;brief:string;manifestSha256:string;agentId:string})=>{
    called.push(input);
    const saved=await f.store.load();
    assert.equal(saved!.pendingSpawns?.[0]?.state,"bootstrap_uncertain");
    assert.equal(saved!.agents.some(a=>a.id===input.agentId),false);
    return {sessionId:"https://chatgpt.com/c/new-real-chat",sessionFingerprint:"verified-new-chat"};
  }};
  const bootstrap=new DynamicAgentBootstrapper(policy,f.store,f.broker,adapter);
  const started=await bootstrap.bootstrap(f.lease);
  assert.equal(started.sessionId,"https://chatgpt.com/c/new-real-chat");
  assert.deepEqual(called.map(x=>({role:x.role,brief:x.brief,pin:x.manifestSha256})),
    [{role:"qa",brief:"Test the original Issue acceptance.",pin}]);
  await assert.rejects(bootstrap.bootstrap(f.lease),/not reserved/);
  assert.equal(called.length,1);
});

test("uncertain provider bootstrap cannot reopen same worker after crash or timeout",async t=>{
  const f=await fixture();t.after(f.close);
  let calls=0;
  const transport={start:async()=>{calls++;throw new Error("provider accepted maybe: lost ACK");}};
  await assert.rejects(new DynamicAgentBootstrapper(policy,f.store,f.broker,transport).bootstrap(f.lease),
    /provider accepted maybe/);
  const recovered=new DynamicAgentBootstrapper(policy,new DynamicAgentStore(f.root,task),f.broker,transport);
  await assert.rejects(recovered.bootstrap(f.lease),/not reserved/);
  assert.equal(calls,1);
  assert.equal((await f.store.load())!.pendingSpawns?.[0]?.state,"bootstrap_uncertain");
  assert.equal((await f.store.load())!.agents.some(x=>x.id==="qa-new"),false);
});

test("provider binding rejection fences ambiguous newly opened chat without admitting agent",async t=>{
  const f=await fixture();t.after(f.close);
  f.denyBinding();
  let calls=0;
  const adapter={start:async()=>{calls++;return{sessionId:"https://chatgpt.com/c/new-real-chat",
    sessionFingerprint:"verified-new-chat"};}};
  const bootstrap=new DynamicAgentBootstrapper(policy,f.store,f.broker,adapter);
  await assert.rejects(bootstrap.bootstrap(f.lease),/Unverified spawned provider identity/);
  await assert.rejects(bootstrap.bootstrap(f.lease),/not reserved/);
  assert.equal(calls,1);
  assert.equal((await f.store.load())!.agents.length,1);
});
