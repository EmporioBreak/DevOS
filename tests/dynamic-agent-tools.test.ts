import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {DynamicAgentToolProtocol} from "../src/dynamic-agent-tools.js";
import {DynamicAgentBroker,DynamicAgentStore,type DynamicAgentPolicy,
  type VerifiedDynamicCaller} from "../src/dynamic-agent-runtime.js";

const task={repo:"EmporioBreak/DevOS",issue:246};
const policy:DynamicAgentPolicy={version:2,task,policyId:"a".repeat(64),
  maxAgents:5,maxPendingPerAgent:8,roles:{
    qa:{executor:"chatgpt_browser",manifestSha256:"b".repeat(64),mayAdmit:true},
    security:{executor:"codex",manifestSha256:"c".repeat(64),mayAdmit:false},
  }};
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"cos-tool-protocol-"));
  let actor:VerifiedDynamicCaller={task,agentId:"main_agent",sessionFingerprint:"owner-proof"};
  const store=new DynamicAgentStore(root,task);
  const broker=new DynamicAgentBroker(policy,store,{
    resolveCaller:async()=>actor,verifyPolicy:async()=>true,verifyNewAgentBinding:async()=>true,
    verifyTransportLease:async()=>true,verifyProviderReceipt:async()=>true,verifyNoSubmit:async()=>false,
    verifyToolCall:async()=>true,verifyIndependentReview:async()=>false,
  });
  await broker.initialize();
  await broker.admit({id:"qa1",role:"qa",sessionFingerprint:"qa-proof"});
  return {store,broker,tools:new DynamicAgentToolProtocol(broker,true),
    as:(id:string)=>actor={task,agentId:id,sessionFingerprint:id==="qa1"?"qa-proof":"owner-proof"},
    close:async()=>rm(root,{recursive:true,force:true})};
}
test("CoS tool protocol permits dynamic peer spawn, direct messages and structured status",async t=>{
  const f=await fixture();t.after(f.close);
  f.as("qa1");
  const r=await f.tools.call({action:"spawn",workers:[{id:"sec1",role:"security",
    brief:"Inspect security boundaries",idempotency_key:"spawn-sec-001"}]});
  assert.equal(r.structuredContent.action,"spawn");
  assert.deepEqual(r.structuredContent.workers,[{id:"sec1",role:"security",state:"reserved"}]);
  assert.equal((await f.store.load())!.agents.some(a=>a.id==="sec1"),false);
  f.as("main_agent");
  await f.broker.admit({id:"sec2",role:"security",sessionFingerprint:"sec-proof"});
  f.as("qa1");
  const result=await f.tools.call({action:"message",messages:[{to:"sec2",kind:"question",
    body:"Audit this API",idempotency_key:"qa-security-001"}]});
  assert.equal((result.structuredContent.queued as Array<{to:string}>)[0]?.to,"sec2");
  const status=await f.tools.call({action:"status"});
  const agents=status.structuredContent.agents as Array<Record<string,unknown>>;
  assert.equal(agents.some(a=>"sessionFingerprint" in a),false);
  assert.equal((status.structuredContent.messages as Array<{to:string}>)[0]?.to,"sec1");
});

test("CoS agent tool rejects spoofed source, session, unsupported role or mixed payload atomically",async t=>{
  const f=await fixture();t.after(f.close);
  const bogus=[
    {action:"message",caller_id:"main_agent",messages:[{to:"qa1",kind:"work",body:"go",idempotency_key:"key-00000001"}]},
    {action:"status",repo:"Other/Repo"},
    {action:"spawn",workers:[{id:"sec1",role:"security",brief:"audit",idempotency_key:"key-00000001",session_id:"stolen"}]},
    {action:"message",messages:[{to:"qa1",kind:"work",body:"go",idempotency_key:"key-00000001"},
      {to:"missing",kind:"work",body:"go",idempotency_key:"key-00000002"}]},
  ];
  for(const request of bogus)await assert.rejects(f.tools.call(request));
  assert.equal((await f.store.load())!.messages.length,0);
  assert.equal((await f.store.load())!.pendingSpawns?.length,0);
});

test("CoS disabled tool never executes any broker action",async t=>{
  const f=await fixture();t.after(f.close);
  const disabled=new DynamicAgentToolProtocol(f.broker,false);
  await assert.rejects(disabled.call({action:"status"}),/not authorized/);
  assert.equal((await f.store.load())!.messages.length,0);
});

test("CoS finish is a worker report, not Main Agent self-approval",async t=>{
  const f=await fixture();t.after(f.close);
  f.as("qa1");
  const result=await f.tools.call({action:"finish",result:"QA validated docs",
    idempotency_key:"qa-finish-0001"});
  assert.equal(result.structuredContent.action,"finish");
  assert.equal((result.structuredContent.report as {to:string}).to,"main_agent");
  assert.equal((await f.store.load())!.ownerDecision,undefined);
  assert.equal((await f.store.load())!.agents.find(a=>a.id==="qa1")!.status,"sleeping");
  await assert.rejects(f.tools.call({action:"request_final_review"}),/Missing host-verified independent review/);
  f.as("main_agent");
  await assert.rejects(f.tools.call({action:"finish",result:"I approve this",
    idempotency_key:"owner-finish-01"}),/Main Agent does not finish/);
});
