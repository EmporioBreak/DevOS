import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {DynamicAgentBroker,DynamicAgentStore,type DynamicAgentPolicy,
  type DynamicWakeLease} from "../src/dynamic-agent-runtime.js";

const task={repo:"Example/DevOS",issue:999};
const policy:DynamicAgentPolicy={version:2,task,policyId:"a".repeat(64),
  maxAgents:3,maxPendingPerAgent:5,
  roles:{qa:{executor:"chatgpt_browser",manifestSha256:"b".repeat(64),mayAdmit:false}}};
async function callChild(root:string,lease:DynamicWakeLease):Promise<{ok:boolean;error?:string;commandId?:string}>{
  const target=fileURLToPath(new URL("./fixtures/dynamic-wake-claim-child.ts",import.meta.url));
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,["--import","tsx",target,root,JSON.stringify(lease)],{
      stdio:["ignore","pipe","pipe"]
    });
    let out="",err="";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data",c=>out+=c);
    child.stderr.on("data",c=>err+=c);
    child.once("error",reject);
    child.once("close",status=>{
      if(status!==0)return reject(new Error("Child exited "+status+": "+err.slice(0,1200)));
      try{resolve(JSON.parse(out.trim()));}catch(e){reject(new Error("Invalid child claim: "+out+" "+err+" "+e));}
    });
  });
}
test("CoS cross-process wake lease admits exactly one claimant to same saved chat",async t=>{
  const root=await mkdtemp(join(tmpdir(),"devos-cos-wake-multiprocess-"));
  t.after(async()=>rm(root,{recursive:true,force:true}));
  let identity="main_agent",fingerprint="owner-proof";
  const broker=new DynamicAgentBroker(policy,new DynamicAgentStore(root,task),{
    resolveCaller:async()=>({task,agentId:identity,sessionFingerprint:fingerprint}),
    verifyPolicy:async()=>true,verifyNewAgentBinding:async()=>true,
    verifyToolCall:async()=>true,verifyTransportLease:async()=>true,
    verifyProviderReceipt:async()=>true,verifyNoSubmit:async()=>false,
    verifyWakeLease:async()=>true,verifyWakeReceipt:async()=>true,
  });
  await broker.initialize();
  await broker.admit({id:"qa1",role:"qa",sessionFingerprint:"qa1-proof"});
  identity="qa1";fingerprint="qa1-proof";
  await broker.bindSession("https://chatgpt.com/c/pinned-qa-session");
  await broker.finishWork({result:"Finished earlier work",idempotencyKey:"completed-task-001"});
  identity="main_agent";fingerprint="owner-proof";
  await broker.send({to:"qa1",kind:"work",body:"New QA task",idempotencyKey:"wake-multiproc-001"});
  const command=(await new DynamicAgentStore(root,task).load())!.wakeCommands![0]!;
  const lease={task,commandId:command.id,recipientId:command.recipientId,
    conversationId:command.conversationId,wakeKey:command.wakeKey};
  const outcomes=await Promise.all([callChild(root,lease),callChild(root,lease)]);
  assert.equal(outcomes.filter(o=>o.ok).length,1,JSON.stringify(outcomes));
  assert.equal(outcomes.filter(o=>!o.ok).length,1,JSON.stringify(outcomes));
  assert.equal((await new DynamicAgentStore(root,task).load())!.wakeCommands![0]!.state,"claimed");
  const again=await callChild(root,lease);
  assert.equal(again.ok,false);
  assert.match(again.error??"",/Wake may already have reached provider|DYNAMIC_STORE_LOCKED/);
});
