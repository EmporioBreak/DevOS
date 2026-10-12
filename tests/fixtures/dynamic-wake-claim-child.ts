import { DynamicAgentBroker, DynamicAgentStore, type DynamicAgentPolicy,
  type DynamicWakeLease } from "../../src/dynamic-agent-runtime.js";

const root=process.argv[2] ?? "";
const lease=JSON.parse(process.argv[3] ?? "null") as DynamicWakeLease;
const policy: DynamicAgentPolicy = {
  version:2,task:lease.task,policyId:"a".repeat(64),maxAgents:3,maxPendingPerAgent:5,
  roles:{qa:{executor:"chatgpt_browser",manifestSha256:"b".repeat(64),mayAdmit:false}},
};
const broker=new DynamicAgentBroker(policy,new DynamicAgentStore(root,lease.task),{
  resolveCaller:async()=>({task:lease.task,agentId:"main_agent",sessionFingerprint:"owner-proof"}),
  verifyPolicy:async()=>true,
  verifyNewAgentBinding:async()=>true,
  verifyToolCall:async()=>true,
  verifyTransportLease:async()=>true,
  verifyProviderReceipt:async()=>true,
  verifyNoSubmit:async()=>false,
  verifyWakeLease:async()=>true,
  verifyWakeReceipt:async()=>true,
});
try {
  const claimed=await broker.claimWake(lease);
  process.stdout.write(JSON.stringify({ok:true,commandId:claimed.id})+"\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ok:false,error:String(error)})+"\n");
}
