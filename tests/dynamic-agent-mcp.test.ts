import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {acquireTaskLock} from "../src/task-lock.js";
import {ChatWorkerProbeRegistry} from "../src/chat-worker-probe.js";
import {DynamicAgentGrantRegistry} from "../src/dynamic-agent-grants.js";
import {DynamicAgentBroker,DynamicAgentStore,type DynamicAgentPolicy,
  type VerifiedDynamicCaller} from "../src/dynamic-agent-runtime.js";
import {sealDynamicAgentPolicy} from "../src/dynamic-agent-policy.js";
import {callDynamicAgentsMcp} from "../src/dynamic-agent-mcp.js";

const task={repo:"EmporioBreak/DevOS",issue:246,pr:247};
const policy:DynamicAgentPolicy={version:2,task,policyId:"a".repeat(64),maxAgents:5,
  maxPendingPerAgent:7,roles:{qa:{executor:"chatgpt_browser",manifestSha256:"b".repeat(64),mayAdmit:true},
    dev:{executor:"codex",manifestSha256:"c".repeat(64),mayAdmit:false}}};
const secret="mcp-bound-owner-secret-"+ "x".repeat(64);
const ownerFp="chat_"+"d".repeat(64),qaFp="chat_"+"e".repeat(64),unownedFp="chat_"+"f".repeat(64);
const chat="https://chatgpt.com/c/7d993a31-ff19-444c-b639-c92369550e38";
const resource="/devos/production/devos_worker_probe";
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"cos-v2-mcp-"));
  const lock=await acquireTaskLock(root,task);
  await sealDynamicAgentPolicy({root,policy,ownerSecret:secret,assertTrustedOwnerApproval:async()=>true});
  let actor:VerifiedDynamicCaller={task,agentId:"main_agent",sessionFingerprint:ownerFp};
  const store=new DynamicAgentStore(root,task);
  const broker=new DynamicAgentBroker(policy,store,{
    resolveCaller:async()=>actor,verifyPolicy:async()=>true,verifyNewAgentBinding:async()=>true,
    verifyToolCall:async()=>true,verifyTransportLease:async()=>true,
    verifyProviderReceipt:async()=>true,verifyNoSubmit:async()=>false,
  });
  await broker.initialize();await broker.admit({id:"qa1",role:"qa",sessionFingerprint:qaFp});
  actor={task,agentId:"qa1",sessionFingerprint:qaFp};await broker.bindSession(chat);
  actor={task,agentId:"main_agent",sessionFingerprint:ownerFp};
  const registry=new DynamicAgentGrantRegistry(root,secret);
  const probe=new ChatWorkerProbeRegistry(root,secret);
  async function bind(){
    const p=probe.issue(qaFp);
    if(p.status!=="issued")throw Error("Probe challenge unavailable");
    const providerMessage={author:{role:"tool",name:"api_tool.call_tool"},
      status:"finished_successfully",metadata:{invoked_resource:{resource_uri:resource}},
      content:{content_type:"code",text:JSON.stringify({
        structuredContent:{status:"issued",nonce:p.nonce}
      })}};
    return registry.bindProvenMessage({task,agentId:"qa1",sessionId:chat,
      providerMessage,resourceUri:resource,policy});
  }
  const call=(fingerprint:string,ownerApproved:()=>boolean,argumentsValue:unknown)=>
    callDynamicAgentsMcp({root,ownerSecret:secret,fingerprint,ownerApproved,argumentsValue});
  return {root,store,broker,registry,bind,call,asQa:()=>actor={task,agentId:"qa1",sessionFingerprint:qaFp},
    close:async()=>{await lock.release();await rm(root,{recursive:true,force:true})}};
}
test("gated MCP v2 verifies real owner session and exact sealed issue policy",async t=>{
  const f=await fixture();t.after(f.close);
  const result=await f.call(ownerFp,()=>true,{action:"status",repo:task.repo,issue:task.issue});
  assert.equal(result.structuredContent.action,"status");
  assert.equal((result.structuredContent.agents as Array<{id:string}>).length,2);
  await assert.rejects(f.call(ownerFp,()=>false,{action:"status",repo:task.repo,issue:task.issue}),
    /Worker cannot select another Issue/);
  await assert.rejects(f.call(unownedFp,()=>true,{action:"status",repo:task.repo,issue:task.issue}),
    /Unverified agent\/session identity/);
  await assert.rejects(f.call(ownerFp,()=>true,{action:"status",repo:task.repo,issue:247}),
    /ENOENT|policy/i);
});
test("v2 worker cannot select other Issue or borrow v1, owner or Mac privilege",async t=>{
  const f=await fixture();t.after(f.close);
  assert.equal(await f.bind(),true);
  const sent=await f.call(qaFp,()=>false,{action:"message",messages:[
    {to:"main_agent",kind:"question",body:"Need exact QA instructions",
      idempotency_key:"qa-owner-question-01"}
  ]});
  assert.equal(sent.structuredContent.action,"message");
  assert.equal((sent.structuredContent.queued as Array<{to:string}>)[0]!.to,"main_agent");
  await assert.rejects(f.call(qaFp,()=>false,{action:"status",repo:task.repo,issue:task.issue}),
    /Worker cannot select another Issue/);
  await assert.rejects(f.call(unownedFp,()=>false,{action:"status"}),
    /No authenticated v2 worker grant/);
  await assert.rejects(f.call(qaFp,()=>true,{action:"status",repo:task.repo,issue:task.issue}),
    /Ambiguous owner and worker session/);
});
test("v2 gateway rechecks worker generation and rejects stale grant after finish",async t=>{
  const f=await fixture();t.after(f.close);assert.equal(await f.bind(),true);
  f.asQa();await f.broker.finishWork({result:"QA finished",idempotencyKey:"qa-v2-finish-01"});
  await assert.rejects(f.call(qaFp,()=>false,{action:"status"}),
    /Worker grant revoked, expired/);
});
