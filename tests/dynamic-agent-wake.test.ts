import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DynamicAgentBroker, DynamicAgentStore, type DynamicAgentPolicy,
  type VerifiedDynamicCaller} from "../src/dynamic-agent-runtime.js";
import {DynamicWakeDispatcher} from "../src/dynamic-agent-wake.js";
import {DynamicAgentScheduler} from "../src/dynamic-agent-scheduler.js";
import {DynamicAgentDispatcher} from "../src/dynamic-agent-dispatch.js";

const task={repo:"EmporioBreak/DevOS",issue:246,pr:247};
const policy:DynamicAgentPolicy={version:2,task,policyId:"d".repeat(64),
  maxAgents:5,maxPendingPerAgent:8,roles:{
    qa:{executor:"chatgpt_browser",manifestSha256:"e".repeat(64),mayAdmit:true},
  }};
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"cos-wake-"));
  let actor:VerifiedDynamicCaller={task,agentId:"main_agent",sessionFingerprint:"owner-proof"};
  let receipt=false,verifiedCall=false;
  const store=new DynamicAgentStore(root,task);
  const trust={
    resolveCaller:async()=>actor,
    verifyPolicy:async()=>true,
    verifyNewAgentBinding:async()=>true,
    verifyTransportLease:async()=>true,
    verifyProviderReceipt:async()=>true,
    verifyNoSubmit:async()=>false,
    verifyToolCall:async()=>verifiedCall,
    verifyWakeLease:async()=>true,
    verifyWakeReceipt:async()=>receipt,
  };
  const broker=new DynamicAgentBroker(policy,store,trust);
  await broker.initialize();
  await broker.admit({id:"qa1",role:"qa",sessionFingerprint:"qa1-proof"});
  actor={task,agentId:"qa1",sessionFingerprint:"qa1-proof"};
  await broker.bindSession("https://chatgpt.com/c/old-qa-chat");
  await broker.finishWork({result:"First cycle completed",idempotencyKey:"first-cycle-001"});
  actor={task,agentId:"main_agent",sessionFingerprint:"owner-proof"};
  return {store,broker,root,
    as:(id:string)=>actor={task,agentId:id,sessionFingerprint:id==="main_agent"?"owner-proof":"qa1-proof"},
    proveReceipt:()=>receipt=true,proveCall:()=>verifiedCall=true,
    close:async()=>rm(root,{recursive:true,force:true})};
}
function leaseOf(state:NonNullable<Awaited<ReturnType<DynamicAgentStore["load"]>>>) {
  const command=state.wakeCommands![0]!;
  return {task,commandId:command.id,recipientId:command.recipientId,
    conversationId:command.conversationId,wakeKey:command.wakeKey};
}
test("CoS bridge wake command is atomic with worker revival and targets exact old chat",async t=>{
  const f=await fixture();t.after(f.close);
  const items=await f.broker.sendBatch([
    {to:"qa1",kind:"work",body:"Review changed code",idempotencyKey:"second-cycle-a"},
    {to:"qa1",kind:"question",body:"Check browser auth",idempotencyKey:"second-cycle-b"},
  ]);
  const state=(await f.store.load())!;
  assert.equal(state.agents.find(a=>a.id==="qa1")!.status,"waking");
  assert.equal(state.wakeCommands?.length,1);
  assert.equal(state.wakeCommands![0]!.conversationId,"https://chatgpt.com/c/old-qa-chat");
  assert.deepEqual(state.wakeCommands![0]!.messageIds,items.map(m=>m.id));
  const lease=leaseOf(state);
  await assert.rejects(f.broker.claimWake({...lease,conversationId:"https://chatgpt.com/c/other-chat"}),
    /Wake command\/exact chat identity mismatch/);
  assert.equal((await f.store.load())!.wakeCommands![0]!.state,"queued");
  const requests:string[]=[];
  const dispatcher=new DynamicWakeDispatcher(f.broker,f.store,{
    send:async req=>{requests.push(req.conversationId);assert.equal(req.messages.length,2);
      assert.deepEqual(req.messages.map(m=>m.id),items.map(m=>m.id));
      return {providerMessageId:"provider-accepted-wake"};}
  });
  await assert.rejects(dispatcher.dispatch(lease),/Unverified provider wake receipt/);
  // The provider may have accepted the message, so an ordinary retry is forbidden.
  assert.equal((await f.store.load())!.wakeCommands![0]!.state,"claimed");
  f.proveReceipt();
  await f.broker.confirmWake(lease,{...lease,providerMessageId:"provider-accepted-wake"});
  assert.deepEqual(requests,["https://chatgpt.com/c/old-qa-chat"]);
  assert.deepEqual((await f.store.load())!.messages.filter(m=>items.some(i=>i.id===m.id))
    .map(m=>m.providerMessageId),["provider-accepted-wake","provider-accepted-wake"]);
  await assert.rejects(dispatcher.dispatch(lease),/not queued/);
  const at=(await f.store.load())!.wakeCommands![0]!.deliveredAt!;
  f.as("qa1");
  f.proveCall();
  assert.equal(await f.broker.noteAgentAlive({task,recipientId:"qa1",callId:"before-wake",startedAt:at}),false);
  assert.equal(await f.broker.noteAgentAlive({task,recipientId:"qa1",callId:"new-worker-call",startedAt:at+1}),true);
  assert.equal((await f.store.load())!.wakeCommands![0]!.state,"alive");
});
test("CoS uncertain browser wake survives restart and cannot submit same work twice",async t=>{
  const f=await fixture();t.after(f.close);
  await f.broker.send({to:"qa1",kind:"work",body:"Fix regression",idempotencyKey:"wake-restart-0001"});
  const lease=leaseOf((await f.store.load())!);
  let sent=0;
  const transport={send:async()=>{sent++;throw new Error("unknown Send result after browser click");}};
  const dispatcher=new DynamicWakeDispatcher(f.broker,f.store,transport);
  await assert.rejects(dispatcher.dispatch(lease),/unknown Send/);
  assert.equal((await f.store.load())!.wakeCommands![0]!.state,"claimed");
  const restarted=new DynamicWakeDispatcher(f.broker,new DynamicAgentStore(f.root,task),transport);
  await assert.rejects(restarted.dispatch(lease),/not queued/);
  assert.equal(sent,1);
  // Independent evidence can reconcile the delivery but never replay it.
  f.proveReceipt();
  await assert.rejects(f.broker.confirmWake(lease,{...lease,conversationId:"other",
    providerMessageId:"provider-matched"}),/Wake receipt\/caller mismatch/);
  await f.broker.confirmWake(lease,{...lease,providerMessageId:"provider-matched"});
  assert.equal((await f.store.load())!.wakeCommands![0]!.state,"delivered");
});
test("CoS graph-free normal scheduler never steals pending exact-chat revival",async t=>{
  const f=await fixture();t.after(f.close);
  await f.broker.send({to:"qa1",kind:"work",body:"Second QA cycle",idempotencyKey:"wake-scheduler-1"});
  let sends=0;
  const ordinary=new DynamicAgentScheduler(f.store,new DynamicAgentDispatcher(f.broker,f.store,{
    send:async()=>{sends++;return {providerMessageId:"wrong-lane"};}
  }));
  assert.deepEqual((await ordinary.drain()).sent,[]);
  assert.equal(sends,0);
  assert.equal((await f.store.load())!.wakeCommands![0]!.state,"queued");
});

test("CoS wake scheduler isolates uncertain QA wake while second sleeping worker proceeds",async t=>{
  const f=await fixture();t.after(f.close);
  f.as("main_agent");
  await f.broker.admit({id:"qa2",role:"qa",sessionFingerprint:"qa2-proof"});
  // Separate authenticated saved conversation for the additional specialist.
  // This fixture's as() only produces qa1-proof; use explicit existing agent
  // session setup below through a task-local second broker identity.
  const otherTrust={
    resolveCaller:async()=>({task,agentId:"qa2",sessionFingerprint:"qa2-proof"}),
    verifyPolicy:async()=>true,verifyNewAgentBinding:async()=>true,
    verifyTransportLease:async()=>true,verifyProviderReceipt:async()=>true,
    verifyNoSubmit:async()=>false,verifyToolCall:async()=>true,
    verifyWakeLease:async()=>true,verifyWakeReceipt:async()=>true,
  };
  const second=new DynamicAgentBroker(policy,f.store,otherTrust);
  await second.bindSession("https://chatgpt.com/c/second-owned-qa");
  await second.finishWork({result:"Old work completed",idempotencyKey:"second-sleep-001"});
  const first=await f.broker.send({to:"qa1",kind:"work",body:"QA first",
    idempotencyKey:"first-uncertain-001"});
  const secondMessage=await f.broker.send({to:"qa2",kind:"work",body:"QA second",
    idempotencyKey:"second-verified-01"});
  const state=await f.store.load();
  assert.equal(state!.wakeCommands?.length,2);
  let calls=0;
  f.proveReceipt();
  const wake=new DynamicWakeDispatcher(f.broker,f.store,{
    send:async input=>{
      calls++;
      if(input.recipientId==="qa1")throw new Error("browser may have accepted");
      return {providerMessageId:"provider-accepted-qa2"};
    }
  });
  const scheduler=new DynamicAgentScheduler(f.store,new DynamicAgentDispatcher(f.broker,f.store,{
    send:async()=>{throw new Error("normal path must not be used");}
  }));
  const report=await scheduler.drainWakes(wake);
  assert.equal(report.blocked.length,1);
  assert.equal(report.blocked[0]!.recipientId,"qa1");
  assert.equal(report.blocked[0]!.reason,"dispatch_uncertain");
  assert.equal(report.sent.length,1);
  assert.equal(calls,2);
  assert.equal((await f.store.load())!.wakeCommands?.find(c=>c.recipientId==="qa1")?.state,"claimed");
  assert.equal((await f.store.load())!.wakeCommands?.find(c=>c.recipientId==="qa2")?.state,"delivered");
  assert.equal((await f.store.load())!.messages.find(m=>m.id===first.id)?.state,"queued");
  assert.equal((await f.store.load())!.messages.find(m=>m.id===secondMessage.id)?.state,"sent");
  assert.deepEqual(await scheduler.drainWakes(wake),{sent:[],blocked:[]});
  assert.equal(calls,2);
});
