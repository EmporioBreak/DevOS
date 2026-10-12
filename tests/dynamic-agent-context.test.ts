import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DynamicAgentBroker,DynamicAgentStore,type DynamicAgentPolicy,
  type DynamicTrustBoundary,type VerifiedDynamicCaller} from "../src/dynamic-agent-runtime.js";

const task={repo:"EmporioBreak/DevOS",issue:246};
const policy:DynamicAgentPolicy={version:2,task,policyId:"c".repeat(64),
  maxAgents:3,maxPendingPerAgent:10,workerContextCeilingTokens:400000,
  contextMeasurementMaxAgeMs:30000,
  roles:{qa:{executor:"chatgpt_browser",manifestSha256:"d".repeat(64),mayAdmit:true}}};
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"cos-context-"));
  let caller:VerifiedDynamicCaller={task,agentId:"main_agent",sessionFingerprint:"owner"};
  let approved=false;
  const trust:DynamicTrustBoundary={
    resolveCaller:async()=>caller,verifyPolicy:async()=>true,
    verifyNewAgentBinding:async()=>true,verifyToolCall:async()=>true,
    verifyTransportLease:async()=>true,verifyProviderReceipt:async()=>true,
    verifyNoSubmit:async()=>false,
    verifyContextMeasurement:async()=>approved
  };
  const store=new DynamicAgentStore(root,task);
  const broker=new DynamicAgentBroker(policy,store,trust);
  await broker.initialize();await broker.admit({id:"qa1",role:"qa",sessionFingerprint:"qa-fingerprint"});
  caller={task,agentId:"qa1",sessionFingerprint:"qa-fingerprint"};
  await broker.bindSession("https://chatgpt.com/c/original-worker");
  return {store,broker,root,
    as:(id:string)=>caller={task,agentId:id,sessionFingerprint:id==="qa1"?"qa-fingerprint":"owner"},
    verify:()=>approved=true,
    measure:(tokens:number,sessionId="https://chatgpt.com/c/original-worker")=>
      broker.noteContextTokens({task,agentId:"qa1",sessionId,
        sessionFingerprint:"qa-fingerprint",tokens,evidenceId:"trusted-host-sample"}),
    cleanup:async()=>rm(root,{recursive:true,force:true})};
}
test("CoS sleeping worker requires current independently verified context measurement before wake",async t=>{
  const f=await fixture();t.after(f.cleanup);
  await f.broker.finishWork({result:"First review done",idempotencyKey:"done-review-one"});
  f.as("main_agent");
  await assert.rejects(f.broker.send({to:"qa1",kind:"work",body:"Recheck after revision",
    idempotencyKey:"recheck-context"}),/WORKER_CONTEXT_UNVERIFIED/);
  await assert.rejects(f.measure(100000),/Unverified context measurement/);
  assert.equal((await f.store.load())!.agents.find(a=>a.id==="qa1")!.contextTokens,undefined);
  f.verify();
  await f.measure(399999);
  const msg=await f.broker.send({to:"qa1",kind:"work",body:"Recheck after revision",
    idempotencyKey:"recheck-context"});
  assert.equal(msg.to,"qa1");
  assert.equal((await f.store.load())!.agents.find(a=>a.id==="qa1")!.status,"waking");
});
test("CoS terminal context ceiling is monotonic and preserves old chat as denial-only authority",async t=>{
  const f=await fixture();t.after(f.cleanup);
  await f.broker.finishWork({result:"Complete",idempotencyKey:"finish-terminal-1"});
  f.as("main_agent");f.verify();
  const crossed=await f.measure(400000);
  assert.equal(crossed.status,"terminal");
  const state=await f.store.load();
  assert.equal(state!.agents.find(a=>a.id==="qa1")!.sessionId,"https://chatgpt.com/c/original-worker");
  await assert.rejects(f.broker.send({to:"qa1",kind:"work",body:"Do it again",
    idempotencyKey:"terminal-wake-one"}),/Recipient cannot accept another wake/);
  await f.measure(250000);
  assert.equal((await f.store.load())!.agents.find(a=>a.id==="qa1")!.contextTokens,400000);
  assert.equal((await f.store.load())!.agents.find(a=>a.id==="qa1")!.status,"terminal");
  await assert.rejects(f.measure(450000,"https://chatgpt.com/c/unowned"),
    /Context measurement conversation\/agent identity mismatch/);
  f.as("qa1");
  const retry=await f.broker.finishWork({result:"Complete",idempotencyKey:"finish-terminal-1"});
  assert.equal(retry.body,"Complete");
  await assert.rejects(f.broker.requestSpawn({id:"sec",role:"qa",
    brief:"New QA worker",idempotencyKey:"terminal-spawn-001"}),/Inactive worker cannot admit specialists/);
});
test("CoS context threshold is not permission to interrupt a currently executing worker",async t=>{
  const f=await fixture();t.after(f.cleanup);f.verify();
  assert.equal((await f.measure(450000)).status,"idle");
  f.as("qa1");
  const report=await f.broker.finishWork({result:"Finished actual ongoing work",
    idempotencyKey:"finish-threshold-001"});
  assert.equal(report.to,"main_agent");
  assert.equal((await f.store.load())!.agents.find(a=>a.id==="qa1")!.status,"terminal");
});
