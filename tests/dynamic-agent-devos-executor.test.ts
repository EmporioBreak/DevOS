import test from "node:test";
import assert from "node:assert/strict";
import {DynamicDevosExecutorAdapter, type DynamicTrustedExecutorHost} from "../src/dynamic-agent-devos-executor.js";
import type {Executor,WorkerRequest} from "../src/executor.js";
import type {WorkerOutput} from "../src/workflow.js";

const task={repo:"EmporioBreak/DevOS",issue:246,pr:247};
const chat="https://chatgpt.com/c/8ae6fc47-4cab-43e4-bc8d-6679512b3f53";
function setup(){
  const calls:Array<{kind:string;request:WorkerRequest}>=[];
  let receipt:string|null="trusted-provider-message-id";
  let binding:string|null="host-proved-session-grant";
  let wrongSession=false;
  let invalidSkills=false;
  const browser:Executor={kind:"chatgpt_browser",async run(request):Promise<WorkerOutput>{
    calls.push({kind:"chatgpt_browser",request});
    return {text:"",sessionId:wrongSession?
      "https://chatgpt.com/c/7b54fc47-4cab-43e4-bc8d-6679512b3f53":chat};
  }};
  const codex:Executor={kind:"codex",async run(request):Promise<WorkerOutput>{
    calls.push({kind:"codex",request});
    return {text:'DEVOS_RESULT {"status":"done"}',sessionId:wrongSession?"unowned-thread":"codex-1"};
  }};
  function prepare(workerId:string,executor:"codex"|"chatgpt_browser",sessionId?:string):WorkerRequest{
    return {
      projectRoot:"/verified/project",prompt:"Host-sourced original task briefing",workerId,
      ...(sessionId?{sessionId}:{}),
      ...(executor==="chatgpt_browser"?{
        dynamicAgentV2:true,
        enforceProjectScope:true,
        reportTurn:{task,active:{workerId,turn:1,tokenHash:"d".repeat(64)}},
      }:{
        codexSkills:{task,workerId:invalidSkills?"other-worker":workerId,mandatory:true},
      })
    };
  }
  const host:DynamicTrustedExecutorHost={
    prepareBootstrap:async input=>prepare(input.agentId,input.executor),
    prepareMessage:async input=>prepare(input.recipient.id,input.recipient.executor as "codex"|"chatgpt_browser",
      input.recipient.sessionId),
    prepareWake:async input=>prepare(input.recipientId,input.executor,input.conversationId),
    verifiedBootstrap:async()=>binding,
    verifiedProviderMessage:async()=>receipt,
  };
  const adapter=new DynamicDevosExecutorAdapter({codex,chatgpt_browser:browser},host);
  return {adapter,calls,host,denyReceipt:()=>receipt=null,denyBinding:()=>binding=null,
    invalidSkills:()=>invalidSkills=true,wrongSession:()=>wrongSession=true};
}
test("real DevOS Executor.run bootstrap adapter accepts only host-proved session and task skills",async()=>{
  const f=setup();
  const created=await f.adapter.start({task,agentId:"codex-worker",role:"developer",brief:"Fix issue",
    executor:"codex",manifestSha256:"a".repeat(64)});
  assert.equal(created.sessionId,"codex-1");
  assert.equal(created.sessionFingerprint,"host-proved-session-grant");
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0]!.request.sessionId,undefined);
  assert.equal(f.calls[0]!.request.codexSkills?.mandatory,true);
});
test("DevOS real adapter refuses fabricated grants and fails closed on unknown bootstrap",async()=>{
  const f=setup();f.denyBinding();
  await assert.rejects(f.adapter.start({task,agentId:"qa",role:"qa",brief:"Check browser",
    executor:"chatgpt_browser",manifestSha256:"a".repeat(64)}),/independently verified worker session/);
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0]!.request.enforceProjectScope,true);
  assert.equal(f.calls[0]!.request.reportTurn?.active.workerId,"qa");
});
test("existing Codex session uses signed skill request and only host-proven execution receipt",async()=>{
  const f=setup();
  const result=await f.adapter.send({task,recipient:{
    id:"dev1",executor:"codex",sessionId:"codex-1"},
    message:{id:"message-id",taskKey:"EmporioBreak/DevOS#246",
      from:"qa",to:"dev1",kind:"work",body:"Fix failed test",
      idempotencyKey:"codex-receipt-001",state:"queued"}});
  assert.equal(result.providerMessageId,"trusted-provider-message-id");
  assert.equal(f.calls[0]!.request.sessionId,"codex-1");
  f.denyReceipt();
  await assert.rejects(f.adapter.send({task,recipient:{
    id:"dev1",executor:"codex",sessionId:"codex-1"},
    message:{id:"message-id-2",taskKey:"EmporioBreak/DevOS#246",
      from:"qa",to:"dev1",kind:"work",body:"Fix again",
      idempotencyKey:"codex-receipt-002",state:"queued"}}),/without independent provider Send receipt/);
});
test("real DevOS adapter never replaces saved ChatGPT conversation during wake",async()=>{
  const f=setup();
  const result=await f.adapter.send({task,recipientId:"qa",conversationId:chat,
    executor:"chatgpt_browser",commandId:"wake-cmd",wakeKey:"e".repeat(64),messages:[{
      id:"m-1",from:"dev",kind:"work",body:"Retest"
    }]});
  assert.equal(result.providerMessageId,"trusted-provider-message-id");
  assert.equal(f.calls[0]!.request.sessionId,chat);
  f.wrongSession();
  await assert.rejects(f.adapter.send({task,recipientId:"qa",conversationId:chat,
    executor:"chatgpt_browser",commandId:"wake-cmd-2",wakeKey:"e".repeat(64),messages:[{
      id:"m-2",from:"dev",kind:"work",body:"Retest again"
    }]}),/Executor changed the exact saved worker conversation/);
});
test("DevOS adapter rejects wrong Codex signed assignment before any external tool invocation",async()=>{
  const f=setup();f.invalidSkills();
  await assert.rejects(f.adapter.start({task,agentId:"dev1",role:"developer",
    brief:"Implement",executor:"codex",manifestSha256:"a".repeat(64)}),
    /mandatory signed skill assignment/);
  assert.equal(f.calls.length,0);
});

test("dynamic waking Codex peer resumes exact original thread with signed skill assignment",async()=>{
  const f=setup();
  const output=await f.adapter.send({task,recipientId:"dev1",executor:"codex",
    conversationId:"codex-1",commandId:"codex-wake-1",wakeKey:"a".repeat(64),
    messages:[{id:"msg-codex-1",from:"qa1",kind:"work",body:"Fix the API"}]});
  assert.equal(output.providerMessageId,"trusted-provider-message-id");
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0]!.kind,"codex");
  assert.equal(f.calls[0]!.request.sessionId,"codex-1");
  assert.equal(f.calls[0]!.request.codexSkills?.mandatory,true);
  f.wrongSession();
  await assert.rejects(f.adapter.send({task,recipientId:"dev1",executor:"codex",
    conversationId:"codex-1",commandId:"codex-wake-2",wakeKey:"b".repeat(64),
    messages:[{id:"msg-codex-2",from:"qa1",kind:"work",body:"Fix again"}]}),
    /Executor changed the exact saved worker conversation\/thread/);
});
