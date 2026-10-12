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
  assert.equal(await f.broker.noteAgentAlive({task,recipientId:"qa1",callId:"before-wake",startedAt:at}),false);
  f.proveCall();
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
