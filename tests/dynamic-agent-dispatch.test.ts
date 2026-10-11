import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DynamicAgentBroker, DynamicAgentStore, type DynamicAgentPolicy,
  type VerifiedDynamicCaller } from "../src/dynamic-agent-runtime.js";
import { DynamicAgentDispatcher } from "../src/dynamic-agent-dispatch.js";

const task = { repo: "EmporioBreak/DevOS", issue: 812 };
const policy: DynamicAgentPolicy = { version: 2, task, policyId: "a".repeat(64), maxAgents: 3,
  maxPendingPerAgent: 8, roles: { qa: { executor: "chatgpt_browser", mayAdmit: false, manifestSha256: "b".repeat(64) } } };
async function setup() {
  const root=await mkdtemp(join(tmpdir(),"agent-dispatch-"));
  let caller: VerifiedDynamicCaller={task,agentId:"main_agent",sessionFingerprint:"owner-binding"};
  const trust={resolveCaller:async()=>caller, verifyPolicy:async()=>true, verifyNewAgentBinding:async()=>true,
    verifyTransportLease:async()=>true, verifyProviderReceipt:async()=>true,verifyNoSubmit:async()=>false};
  const store=new DynamicAgentStore(root,task),broker=new DynamicAgentBroker(policy,store,trust);
  await broker.initialize(); await broker.admit({id:"qa",role:"qa",sessionFingerprint:"qa-binding"});
  caller={task,agentId:"qa",sessionFingerprint:"qa-binding"};
  await broker.bindSession("https://chatgpt.com/c/qa-owned-chat");
  caller={task,agentId:"main_agent",sessionFingerprint:"owner-binding"};
  const msg=await broker.send({to:"qa",kind:"work",body:"Verify browser",idempotencyKey:"qa-deliver-0001"});
  const lease={task,recipientId:"qa",messageId:msg.id};
  return {root,store,broker,lease,cleanup:async()=>rm(root,{recursive:true,force:true})};
}
test("dispatcher uses saved session, verifies receipt and never re-sends",async t=>{
  const f=await setup();t.after(f.cleanup);
  let sends=0;
  const dispatcher=new DynamicAgentDispatcher(f.broker,f.store,{send:async req=>{
    sends++; assert.equal(req.recipient.sessionId,"https://chatgpt.com/c/qa-owned-chat");
    return {providerMessageId:"provider-receipt-verified"};
  }});
  assert.equal((await dispatcher.dispatch(f.lease)).state,"sent");
  await assert.rejects(dispatcher.dispatch(f.lease),/not claimable/);
  assert.equal(sends,1);
});
test("ambiguous provider send persists fence after restart and refuses second send",async t=>{
  const f=await setup();t.after(f.cleanup);
  let sends=0;
  const adapter={send:async()=>{sends++;throw new Error("Unknown browser send outcome");}};
  await assert.rejects(new DynamicAgentDispatcher(f.broker,f.store,adapter).dispatch(f.lease),/Unknown browser send outcome/);
  const restarted=new DynamicAgentDispatcher(f.broker,new DynamicAgentStore(f.root,task),adapter);
  await assert.rejects(restarted.dispatch(f.lease),/not claimable/);
  assert.equal((await f.store.load())!.messages[0]!.state,"dispatch_uncertain");
  assert.equal(sends,1);
});
