import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {Page} from "playwright-core";
import {ChatWorkerProbeRegistry} from "../src/chat-worker-probe.js";
import {ChatWorkerGrantRegistry} from "../src/chat-worker-grants.js";
import {acquireTaskLock} from "../src/task-lock.js";
import {DynamicAgentBroker,DynamicAgentStore,type DynamicAgentPolicy} from "../src/dynamic-agent-runtime.js";
import {DynamicAgentGrantRegistry} from "../src/dynamic-agent-grants.js";
import {sealDynamicAgentPolicy} from "../src/dynamic-agent-policy.js";
import {observeDynamicWorkerAuthorization} from "../src/dynamic-agent-observer.js";

const task={repo:"EmporioBreak/DevOS",issue:246,pr:247};
const policy:DynamicAgentPolicy={version:2,task,policyId:"a".repeat(64),
  maxAgents:4,maxPendingPerAgent:8,roles:{qa:{executor:"chatgpt_browser",
    manifestSha256:"b".repeat(64),mayAdmit:true}}};
const secret="local-v2-provider-observer-secret-"+ "z".repeat(64);
const fp="chat_"+"c".repeat(64);
const url="https://chatgpt.com/c/83cfdfbd-2195-44c8-b5e2-f18839d6c9b2";
const resource="/devos/production/devos_worker_probe";
const prompt="Issue #246 QA must use exact probe from original conversation";
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"cos-v2-provider-observer-"));
  const lock=await acquireTaskLock(root,task);
  await sealDynamicAgentPolicy({root,policy,ownerSecret:secret});
  let caller="main_agent";
  const store=new DynamicAgentStore(root,task);
  const broker=new DynamicAgentBroker(policy,store,{
    resolveCaller:async()=>({task,agentId:caller,sessionFingerprint:caller==="main_agent"?"owner":fp}),
    verifyPolicy:async()=>true,verifyNewAgentBinding:async()=>true,
    verifyTransportLease:async()=>true,verifyProviderReceipt:async()=>true,
    verifyNoSubmit:async()=>false,verifyToolCall:async()=>true,
  });
  await broker.initialize();
  await broker.admit({id:"qa1",role:"qa",sessionFingerprint:fp});
  caller="qa1";await broker.bindSession(url);
  const probe=new ChatWorkerProbeRegistry(root,secret);
  const issued=probe.issue(fp);
  if(issued.status!=="issued")throw Error("Missing trusted probe");
  const cid=url.split("/c/")[1];
  const history={conversation_id:cid,messages:[
    {id:"user-1",author:{role:"user"},content:{content_type:"text",parts:[prompt]}},
    {id:"tool-1",author:{role:"tool",name:"api_tool.call_tool"},
      status:"finished_successfully",metadata:{invoked_resource:{resource_uri:resource}},
      content:{content_type:"code",text:JSON.stringify({status:"issued",nonce:issued.nonce})}}
  ]};
  return {root,history,
    close:async()=>{await lock.release();await rm(root,{recursive:true,force:true})}};
}
function page(history:unknown,origin="https://chatgpt.com",status=200){
  let reads=0,closed=0;
  const response={url:()=>origin+"/backend-api/conversations/"+url.split("/c/")[1],
    status:()=>status,request:()=>({method:()=>"GET"}),json:async()=>history};
  const verifier={
    url:()=>url,
    waitForResponse:(predicate:(r:typeof response)=>boolean)=>{
      if(!predicate(response))return Promise.reject(new Error("wrong provider endpoint"));
      return Promise.resolve(response);
    },
    goto:async()=>null,
    close:async()=>{closed++;}
  };
  const worker={
    url:()=>url,
    bringToFront:async()=>undefined,
    context:()=>({newPage:async()=>{reads++;return verifier;}})
  } as unknown as Page;
  return {worker,stats:()=>({reads,closed})};
}
test("v2 browser observer reads exact real-provider tool result and never grants legacy v1 access",async t=>{
  const f=await fixture();t.after(f.close);
  const fake=page(f.history),controller=new AbortController();
  const granted=await observeDynamicWorkerAuthorization({
    page:fake.worker,root:f.root,ownerSecret:secret,policy,task,agentId:"qa1",
    resourceUri:resource,expectedConversation:()=>url,
    expectedUserMessageId:()=>undefined,exactSubmittedPrompt:prompt,
    signal:controller.signal,
  });
  assert.equal(granted,true);
  assert.deepEqual(fake.stats(),{reads:1,closed:1});
  assert.deepEqual(await new DynamicAgentGrantRegistry(f.root,secret).resolveCaller(fp,policy),
    {task,agentId:"qa1",sessionFingerprint:fp});
  assert.equal(new ChatWorkerGrantRegistry(f.root,secret).isGranted(fp),false);
});
test("v2 observer rejects false provider HTTPS origin without consuming challenge",async t=>{
  const f=await fixture();t.after(f.close);
  const fake=page(f.history,"https://attacker.example");
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),80);
  try{
    const granted=await observeDynamicWorkerAuthorization({
      page:fake.worker,root:f.root,ownerSecret:secret,policy,task,agentId:"qa1",
      resourceUri:resource,expectedConversation:()=>url,
      expectedUserMessageId:()=>undefined,exactSubmittedPrompt:prompt,
      signal:controller.signal
    });
    assert.equal(granted,false);
    assert.equal(await new DynamicAgentGrantRegistry(f.root,secret).resolveCaller(fp,policy),null);
  }finally{clearTimeout(timer);}
});
