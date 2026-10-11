import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DynamicAgentBroker, DynamicAgentStore, type DynamicAgentPolicy, type VerifiedDynamicCaller } from "../src/dynamic-agent-runtime.js";
import { DynamicAgentDispatcher } from "../src/dynamic-agent-dispatch.js";
import { DynamicAgentScheduler } from "../src/dynamic-agent-scheduler.js";

const task={repo:"Example/DevOS",issue:461};
const policy:DynamicAgentPolicy={version:2,task,policyId:"a".repeat(64),maxAgents:4,maxPendingPerAgent:6,roles:{
  dev:{executor:"codex",manifestSha256:"c".repeat(64),mayAdmit:false},
  qa:{executor:"chatgpt_browser",manifestSha256:"d".repeat(64),mayAdmit:true},
  security:{executor:"codex",manifestSha256:"e".repeat(64),mayAdmit:false},
}};
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"dynamic-scheduler-"));
  let actor:VerifiedDynamicCaller={task,agentId:"main_agent",sessionFingerprint:"owner"};
  const store=new DynamicAgentStore(root,task),broker=new DynamicAgentBroker(policy,store,{
    resolveCaller:async()=>actor,verifyPolicy:async()=>true,verifyNewAgentBinding:async()=>true,
    verifyTransportLease:async()=>true,verifyProviderReceipt:async()=>true,verifyNoSubmit:async()=>false,
  });
  await broker.initialize();
  async function add(id:string,role:string){actor={task,agentId:"main_agent",sessionFingerprint:"owner"};
    await broker.admit({id,role,sessionFingerprint:id});actor={task,agentId:id,sessionFingerprint:id};await broker.bindSession("saved-"+id);}
  return {root,broker,store,add,as:(id:string)=>{actor={task,agentId:id,sessionFingerprint:id==="main_agent"?"owner":id};},
    close:async()=>rm(root,{recursive:true,force:true})};
}
test("one peer's ambiguous send cannot block another peer or be retried",async t=>{
  const f=await fixture();t.after(f.close);
  await f.add("dev","dev");await f.add("qa","qa");f.as("main_agent");
  const a=await f.broker.send({to:"qa",kind:"work",body:"test",idempotencyKey:"req-qa-0001"});
  const b=await f.broker.send({to:"dev",kind:"work",body:"implement",idempotencyKey:"req-dev-001"});
  const calls:string[]=[];
  const adapter={send:async({message}:{message:{id:string}})=>{
    calls.push(message.id);
    if(message.id===a.id)throw new Error("maybe sent");
    return {providerMessageId:"provider-"+message.id};
  }};
  const scheduler=new DynamicAgentScheduler(f.store,new DynamicAgentDispatcher(f.broker,f.store,adapter));
  const result=await scheduler.drain();
  assert.deepEqual(result.sent,[b.id]);
  assert.deepEqual(result.blocked,[{messageId:a.id,recipientId:"qa",reason:"dispatch_uncertain"}]);
  assert.deepEqual((await scheduler.drain()).sent,[]);
  assert.deepEqual(calls,[a.id,b.id]);
});
test("new specialist gets work without any predeclared transition",async t=>{
  const f=await fixture();t.after(f.close);
  await f.add("qa","qa");f.as("qa");
  await f.broker.admit({id:"sec",role:"security",sessionFingerprint:"sec"});
  f.as("sec");await f.broker.bindSession("saved-sec");f.as("qa");
  const message=await f.broker.send({to:"sec",kind:"review",body:"audit",idempotencyKey:"qa-sec-00001"});
  const called:string[]=[];
  const scheduler=new DynamicAgentScheduler(f.store,new DynamicAgentDispatcher(f.broker,f.store,{
    send:async req=>{called.push(req.recipient.id);return{providerMessageId:"provider-accept"};},
  }));
  assert.deepEqual((await scheduler.drain()).sent,[message.id]);
  assert.deepEqual(called,["sec"]);
});
