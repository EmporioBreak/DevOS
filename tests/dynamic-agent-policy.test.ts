import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,readFile,writeFile,symlink,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {DynamicAgentBroker,DynamicAgentStore,type DynamicAgentPolicy} from "../src/dynamic-agent-runtime.js";
import {dynamicPolicyPath,sealDynamicAgentPolicy,verifySealedDynamicAgentPolicy,
  sealedDynamicPolicyVerifier} from "../src/dynamic-agent-policy.js";

const task={repo:"EmporioBreak/DevOS",issue:246,pr:247};
const secret="owner-unexported-authenticated-secret-"+ "q".repeat(64);
const policy:DynamicAgentPolicy={version:2,task,policyId:"a".repeat(64),
  maxAgents:6,maxPendingPerAgent:8,workerContextCeilingTokens:400000,
  roles:{developer:{executor:"codex",manifestSha256:"b".repeat(64),mayAdmit:true},
    qa:{executor:"chatgpt_browser",manifestSha256:"c".repeat(64),mayAdmit:false}}};
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"dynamic-v2-policy-"));
  return {root,close:async()=>rm(root,{recursive:true,force:true})};
}
test("sealed COS dynamic policy can be used as actual broker authorization gate",async t=>{
  const f=await fixture();t.after(f.close);
  const checker=sealedDynamicPolicyVerifier(f.root,secret);
  const broker=new DynamicAgentBroker(policy,new DynamicAgentStore(f.root,task),{
    resolveCaller:async()=>({task,agentId:"main_agent",sessionFingerprint:"exact-owner-fingerprint"}),
    verifyPolicy:checker,verifyNewAgentBinding:async()=>true,
    verifyToolCall:async()=>true,verifyTransportLease:async()=>true,
    verifyProviderReceipt:async()=>false,verifyNoSubmit:async()=>false,
  });
  assert.equal(await checker(policy),false);
  await assert.rejects(broker.initialize(),/Unapproved dynamic task policy/);
  const signed=await sealDynamicAgentPolicy({root:f.root,policy,ownerSecret:secret,
    assertTrustedOwnerApproval:async meta=>{
      assert.equal(meta.policyId,policy.policyId);
      assert.equal(meta.task.issue,246);
      assert.match(meta.sha256,/^[a-f0-9]{64}$/);
      return true;
    }});
  assert.match(signed,/^[a-f0-9]{64}$/);
  assert.equal(await checker(policy),true);
  await broker.initialize();
  assert.equal((await broker.status()).agents[0]!.id,"main_agent");
  const repeated=await sealDynamicAgentPolicy({root:f.root,policy,ownerSecret:secret,
    assertTrustedOwnerApproval:async()=>true});
  assert.equal(repeated,signed);
});
test("owner MAC rejects modified policy, foreign task, wrong secret and unapproved policy changes",async t=>{
  const f=await fixture();t.after(f.close);
  await assert.rejects(sealDynamicAgentPolicy({root:f.root,policy,ownerSecret:secret,
    assertTrustedOwnerApproval:async()=>false}),/Exact owner approval required/);
  await assert.rejects(readFile(dynamicPolicyPath(f.root,task),"utf8"),/ENOENT/);
  await sealDynamicAgentPolicy({root:f.root,policy,ownerSecret:secret,
    assertTrustedOwnerApproval:async()=>true});
  assert.equal(await verifySealedDynamicAgentPolicy({root:f.root,policy,ownerSecret:secret}),true);
  await assert.rejects(verifySealedDynamicAgentPolicy({root:f.root,policy,
    ownerSecret:secret+"wrong"}),/owner MAC is invalid/);
  await assert.rejects(verifySealedDynamicAgentPolicy({root:f.root,policy:{
    ...policy,roles:{...policy.roles,security:{executor:"codex",
      manifestSha256:"d".repeat(64),mayAdmit:true}}},ownerSecret:secret}),
      /revision differs/);
  await assert.rejects(sealDynamicAgentPolicy({root:f.root,
    policy:{...policy,maxAgents:9},ownerSecret:secret,
    assertTrustedOwnerApproval:async()=>true}),/already sealed/);
  const otherTask={...task,pr:999};
  await assert.rejects(verifySealedDynamicAgentPolicy({root:f.root,
    policy:{...policy,task:otherTask},ownerSecret:secret}),/signature or task binding missing/);
});
test("tampering with signed payload or symlinked scope fails closed",async t=>{
  const f=await fixture();t.after(f.close);
  await sealDynamicAgentPolicy({root:f.root,policy,ownerSecret:secret,
    assertTrustedOwnerApproval:async()=>true});
  const file=dynamicPolicyPath(f.root,task);
  const data=JSON.parse(await readFile(file,"utf8"));
  data.policy.roles.qa.mayAdmit=true;
  await writeFile(file,JSON.stringify(data)+"\n");
  assert.equal(await sealedDynamicPolicyVerifier(f.root,secret)(policy),false);
  await rm(file);
  const outside=join(f.root,"external");
  await mkdir(outside);
  await symlink(outside,file);
  await assert.rejects(sealDynamicAgentPolicy({root:f.root,policy,ownerSecret:secret,
    assertTrustedOwnerApproval:async()=>true}),/not private and regular/);
});
