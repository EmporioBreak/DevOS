import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DynamicAgentBroker, DynamicAgentStore, type DynamicAgentPolicy,
 type VerifiedDynamicCaller, type DynamicDeliveryReceipt, type DynamicNoSubmitProof } from "../src/dynamic-agent-runtime.js";

const pin = "f".repeat(64);
const task = { repo: "Example/DevOS", issue: 246, pr: 247 };
const policy: DynamicAgentPolicy = { version: 2, task, policyId: "a".repeat(64), maxAgents: 5,
  maxPendingPerAgent: 2, roles: {
    developer: { executor: "codex", manifestSha256: pin, mayAdmit: false },
    qa: { executor: "chatgpt_browser", manifestSha256: pin, mayAdmit: true },
    security: { executor: "codex", manifestSha256: pin, mayAdmit: false },
    reviewer: { executor: "chatgpt_browser", manifestSha256: pin, mayAdmit: false },
  } };
async function fixture(config: DynamicAgentPolicy = policy) {
  const root = await mkdtemp(join(tmpdir(), "dynamic-agent-test-"));
  let identity: VerifiedDynamicCaller = { task: config.task, agentId: "main_agent", sessionFingerprint: "owner-proof" };
  let allowReceipt = false;
  let allowRecovery = false;
  let allowTool = false;
  let allowTransport = true;
  const store = new DynamicAgentStore(root, config.task);
  const trust = {
    resolveCaller: async () => identity,
    verifyPolicy: async () => true,
    verifyNewAgentBinding: async () => true,
    verifyTransportLease: async () => allowTransport,
    verifyToolCall: async () => allowTool,
    verifyProviderReceipt: async (_receipt: DynamicDeliveryReceipt) => allowReceipt,
    verifyNoSubmit: async (_proof: DynamicNoSubmitProof) => allowRecovery,
  };
  const broker = new DynamicAgentBroker(config, store, trust);
  return { root, store, broker,
    as: (agentId: string, sessionFingerprint = agentId + "-proof") => { identity = { task: config.task, agentId, sessionFingerprint }; },
    crossTask: () => { identity = { task: { repo: "Evil/Other", issue: 1 }, agentId: "main_agent", sessionFingerprint: "owner-proof" }; },
    allowReceipt: () => { allowReceipt = true; }, allowRecovery: () => { allowRecovery = true; }, allowTool: () => { allowTool = true; }, denyTransport: () => {allowTransport = false;},
    close: async () => { await rm(root, { recursive: true, force: true }); },
  };
}

test("direct developer->QA->Security works without a prime relay or worker.on graph", async t => {
  const f = await fixture(); t.after(f.close);
  await f.broker.initialize();
  await f.broker.admit({ id: "dev", role: "developer", sessionFingerprint: "dev-proof" });
  await f.broker.admit({ id: "qa1", role: "qa", sessionFingerprint: "qa1-proof" });
  f.as("dev");
  const a = await f.broker.send({ to: "qa1", kind: "work", body: "Check integration", idempotencyKey: "integration-01" });
  const same = await f.broker.send({ to: "qa1", kind: "work", body: "Check integration", idempotencyKey: "integration-01" });
  assert.equal(same.id, a.id);
  assert.equal((await f.broker.status()).messages.length, 1);
  f.as("qa1");
  await assert.rejects(f.broker.send({ to: "security1", kind: "question", body: "Check TLS", idempotencyKey: "sec-req-01" }), /Unknown recipient/);
  const specialist = await f.broker.admit({ id: "security1", role: "security", sessionFingerprint: "security1-proof" });
  assert.equal(specialist.role, "security");
  const b = await f.broker.send({ to: "security1", kind: "question", body: "Check TLS", idempotencyKey: "sec-req-01", inReplyTo: a.id });
  assert.equal(b.from, "qa1");
  f.as("security1");
  const c = await f.broker.send({ to: "dev", kind: "review", body: "TLS issue discovered", idempotencyKey: "review-001", inReplyTo: b.id });
  assert.equal(c.to, "dev");
  assert.deepEqual((await f.broker.status()).messages.map(x=>x.from+">"+x.to),["qa1>security1","security1>dev"]);
  assert.equal("sessionFingerprint" in (await f.broker.status()).agents[0]!, false);
  assert.deepEqual((await f.store.load())!.messages.map(x=>x.from+">"+x.to),["dev>qa1","qa1>security1","security1>dev"]);
});

test("unknown, cross-task, wrong-session and unauthorized admission all fail closed", async t => {
  const f = await fixture(); t.after(f.close);
  await f.broker.initialize();
  await f.broker.admit({ id: "dev", role: "developer", sessionFingerprint: "dev-proof" });
  f.as("dev");
  await assert.rejects(f.broker.admit({ id: "qa", role: "qa", sessionFingerprint: "qa-proof" }),/cannot admit/);
  await assert.rejects(f.broker.send({ to: "main_agent", kind: "work", body: "go", idempotencyKey: "task-one-01", inReplyTo: "missing" }),/Invalid reply chain/);
  f.as("dev", "spoofed");
  await assert.rejects(f.broker.status(), /Unverified agent/);
  f.crossTask();
  await assert.rejects(f.broker.status(), /Cross-task/);
  f.as("main_agent", "owner-proof");
  await assert.rejects(f.broker.admit({ id: "special", role: "architect", sessionFingerprint: "special-proof" }),/outside task policy/);
  assert.equal((await f.broker.status()).agents.length,2);
});

test("claim-before-send fences uncertain delivery across process restart; only verified receipt can ACK", async t => {
  const f = await fixture(); t.after(f.close);
  await f.broker.initialize();
  await f.broker.admit({ id: "qa", role: "qa", sessionFingerprint: "qa-proof" });
  const msg = await f.broker.send({ to: "qa", kind: "work", body: "Run tests", idempotencyKey: "run-0001" });
  f.as("qa");
  await assert.rejects(f.broker.acknowledge(msg.id), /not confirmed/);
  await f.broker.claimForDelivery(msg.id);
  assert.equal((await f.store.load())!.messages[0]!.state, "dispatch_uncertain");
  const restored = new DynamicAgentBroker(policy, new DynamicAgentStore(f.root, task), {
    resolveCaller: async () => ({ task, agentId: "qa", sessionFingerprint: "qa-proof" }),
    verifyPolicy: async () => true, verifyNewAgentBinding: async () => true, verifyTransportLease: async () => true, verifyToolCall: async () => true,
    verifyProviderReceipt: async () => true, verifyNoSubmit: async () => false,
  });
  await assert.rejects(restored.claimForDelivery(msg.id), /not claimable/);
  await assert.rejects(f.broker.releaseProvenUnsubmitted({ task, messageId: msg.id, evidenceId: "pre-send-verified" }),/Missing independent/);
  await assert.rejects(f.broker.confirmDelivery({ task, messageId: msg.id, providerMessageId: "provider-unique-id" }),/Unverified provider/);
  const sent = await restored.confirmDelivery({ task, messageId: msg.id, providerMessageId: "provider-unique-id" });
  assert.equal(sent.state,"sent");
  await restored.acknowledge(msg.id);
  assert.equal((await restored.status()).messages[0]!.state,"acked");
  await assert.rejects(restored.claimForDelivery(msg.id),/not claimable/);
});

test("no-submit retry requires verified recovery; duplicate idempotency key cannot change payload", async t=>{
  const f = await fixture(); t.after(f.close);
  await f.broker.initialize(); await f.broker.admit({ id:"dev",role:"developer",sessionFingerprint:"dev-proof"});
  const input = { to:"dev",kind:"work" as const,body:"make change",idempotencyKey:"req-0000001" };
  const first = await f.broker.send(input);
  await assert.rejects(f.broker.send({ ...input, body:"delete database" }),/Idempotency-key payload conflict/);
  f.as("dev"); await f.broker.claimForDelivery(first.id);
  f.allowRecovery();
  await f.broker.releaseProvenUnsubmitted({task,messageId:first.id,evidenceId:"host-external-proof"});
  assert.equal((await f.broker.status()).messages[0]!.state,"queued");
  await f.broker.claimForDelivery(first.id);
  assert.equal((await f.broker.status()).messages[0]!.state,"dispatch_uncertain");
});

test("review handoff requires independent acknowledged evidence and owner decision", async t=>{
  const f = await fixture(); t.after(f.close);
  await f.broker.initialize(); await f.broker.admit({ id:"qa",role:"qa",sessionFingerprint:"qa-proof"});
  f.as("qa");
  await assert.rejects(f.broker.requestFinalReview(),/No acknowledged independent evidence/);
  const msg=await f.broker.send({to:"main_agent",kind:"evidence",body:"real tests passed",idempotencyKey:"evidence-000001"});
  f.as("main_agent","owner-proof");
  await f.broker.claimForDelivery(msg.id); f.allowReceipt();
  await f.broker.confirmDelivery({task,messageId:msg.id,providerMessageId:"owner-delivery-1"});
  await f.broker.acknowledge(msg.id);
  f.as("qa"); await f.broker.requestFinalReview();
  await assert.rejects(f.broker.decideFinalReview("approved"),/Main Agent review required/);
  f.as("main_agent","owner-proof");
  await f.broker.decideFinalReview("changes_requested");
  assert.equal((await f.broker.status()).ownerDecision,"changes_requested");
  f.as("qa"); await f.broker.requestFinalReview();
  f.as("main_agent","owner-proof"); await f.broker.decideFinalReview("approved");
  await assert.rejects(f.broker.send({to:"qa",kind:"work",body:"again",idempotencyKey:"morework-0001"}),/already accepted/);
});

test("bounded queue and exclusive interprocess lock preserve state, separate Issue stores", async t => {
  const f = await fixture(); t.after(f.close);
  await f.broker.initialize(); await f.broker.admit({ id:"dev",role:"developer",sessionFingerprint:"dev-proof"});
  await f.broker.send({to:"dev",kind:"work",body:"first",idempotencyKey:"send-00001"});
  await f.broker.send({to:"dev",kind:"work",body:"second",idempotencyKey:"send-00002"});
  await assert.rejects(f.broker.send({to:"dev",kind:"work",body:"third",idempotencyKey:"send-00003"}),/Inbox budget exhausted/);
  const fakeLock=`${f.store.path}.lock`;
  await writeFile(fakeLock,"writer-pid-unverified");
  await assert.rejects(f.broker.send({to:"dev",kind:"work",body:"third",idempotencyKey:"send-00003"}),/DYNAMIC_STORE_LOCKED/);
  await rm(fakeLock);
  assert.equal((await f.store.load())!.messages.length, 2);
  const other=new DynamicAgentStore(f.root,{repo:task.repo,issue:task.issue+1});
  assert.equal(await other.load(),null);
  const content=await readFile(f.store.path,"utf8"); assert.match(content,/send-00002/);
});

test("host transports can claim and wake another agent without forging its caller identity", async t => {
  const f = await fixture(); t.after(f.close);
  await f.broker.initialize(); await f.broker.admit({ id: "qa", role: "qa", sessionFingerprint: "qa-proof" });
  const message = await f.broker.send({ to: "qa", kind: "work", body: "Check the UI", idempotencyKey: "wake-unique-0001" });
  const lease = { task, recipientId: "qa", messageId: message.id };
  await assert.rejects(f.broker.claimForTransport({ ...lease, recipientId: "dev" }), /recipient\/message mismatch/);
  assert.equal((await f.broker.claimForTransport(lease)).state,"dispatch_uncertain");
  await assert.rejects(f.broker.claimForTransport(lease),/not claimable/);
  f.allowReceipt();
  await f.broker.confirmTransportDelivery(lease, { task, messageId: message.id, providerMessageId: "unique-provider-receipt-02" });
  f.as("qa"); await f.broker.acknowledge(message.id);
  assert.equal((await f.store.load())!.messages[0]!.state,"acked");
});

test("policy must be approved and newly admitted identity must be host-verified", async t => {
  const root = await mkdtemp(join(tmpdir(),"dynamic-agent-negative-")); t.after(async () => { await rm(root,{recursive:true,force:true}); });
  let policyApproved = false, identityApproved = false;
  const broker = new DynamicAgentBroker(policy, new DynamicAgentStore(root, task), {
    resolveCaller: async () => ({ task, agentId:"main_agent", sessionFingerprint:"real-main-agent-proof" }),
    verifyPolicy: async () => policyApproved,
    verifyNewAgentBinding: async () => identityApproved,
    verifyTransportLease: async () => false,
    verifyToolCall: async () => false,
    verifyProviderReceipt: async () => false,
    verifyNoSubmit: async () => false,
  });
  await assert.rejects(broker.initialize(),/Unapproved dynamic task policy/);
  policyApproved = true; await broker.initialize();
  await assert.rejects(broker.admit({id:"dev",role:"developer",sessionFingerprint:"fake"}),/Unverified new agent identity/);
  identityApproved = true; await broker.admit({id:"dev",role:"developer",sessionFingerprint:"real-worker-proof"});
  assert.equal((await broker.status()).agents.length,2);
});

test("per-recipient delivery order is enforced despite independent senders", async t=>{
  const f=await fixture();t.after(f.close);
  await f.broker.initialize();await f.broker.admit({id:"qa",role:"qa",sessionFingerprint:"qa-proof"});
  const one=await f.broker.send({to:"qa",kind:"work",body:"first",idempotencyKey:"order-first-0001"});
  const two=await f.broker.send({to:"qa",kind:"work",body:"second",idempotencyKey:"order-next-0002"});
  const later={task,recipientId:"qa",messageId:two.id};
  await assert.rejects(f.broker.claimForTransport(later),/Recipient queue order violation/);
  const first={task,recipientId:"qa",messageId:one.id};
  await f.broker.claimForTransport(first); f.allowReceipt();
  await f.broker.confirmTransportDelivery(first,{task,messageId:one.id,providerMessageId:"provider-first"});
  f.as("qa"); await f.broker.acknowledge(one.id);
  f.as("main_agent","owner-proof"); await f.broker.claimForTransport(later);
  assert.equal((await f.store.load())!.messages[1]!.state,"dispatch_uncertain");
});

test("CoS-style batch admission is all-or-nothing across recipients", async t => {
  const f = await fixture(); t.after(f.close);
  await f.broker.initialize();
  await f.broker.admit({id:"dev",role:"developer",sessionFingerprint:"dev-proof"});
  await f.broker.admit({id:"qa",role:"qa",sessionFingerprint:"qa-proof"});
  const valid={to:"dev",kind:"work" as const,body:"one",idempotencyKey:"batch-dev-001"};
  await assert.rejects(f.broker.sendBatch([valid,
    {to:"nonexistent",kind:"work",body:"two",idempotencyKey:"batch-bad-002"}]),/Unknown recipient/);
  assert.equal((await f.store.load())!.messages.length,0);
  const batch=await f.broker.sendBatch([valid,
    {to:"qa",kind:"review",body:"independent review",idempotencyKey:"batch-qa-0002"}]);
  assert.deepEqual(batch.map(m=>m.to),["dev","qa"]);
  assert.equal((await f.store.load())!.messages.length,2);
  const repeated=await f.broker.sendBatch([valid,valid]);
  assert.equal(repeated[0]!.id,batch[0]!.id);
  assert.equal(repeated[1]!.id,batch[0]!.id);
  assert.equal((await f.store.load())!.messages.length,2);
});

test("CoS batch reserves per-recipient queue capacity before any durable write", async t => {
  const f=await fixture(); t.after(f.close);await f.broker.initialize();
  await f.broker.admit({id:"qa",role:"qa",sessionFingerprint:"qa-proof"});
  const batch=[{to:"qa",kind:"work" as const,body:"one",idempotencyKey:"cap-qa-00001"},
    {to:"qa",kind:"work" as const,body:"two",idempotencyKey:"cap-qa-00002"},
    {to:"qa",kind:"work" as const,body:"three",idempotencyKey:"cap-qa-00003"}];
  await assert.rejects(f.broker.sendBatch(batch),/Inbox budget exhausted/);
  assert.equal((await f.store.load())!.messages.length,0);
  assert.equal((await f.broker.sendBatch(batch.slice(0,2))).length,2);
  assert.equal((await f.store.load())!.messages.length,2);
});

test("CoS MCP inbox reoffers lost tool results, only subsequent proved call retires message", async t => {
  const f=await fixture();t.after(f.close);await f.broker.initialize();
  await f.broker.admit({id:"qa",role:"qa",sessionFingerprint:"qa-proof"});
  const msg=await f.broker.send({to:"qa",kind:"question",body:"Please validate",idempotencyKey:"offer-tool-0001"});
  f.as("qa");await f.broker.bindSession("qa-authenticated-c");
  const first=await f.broker.offerToolInbox();
  assert.equal(first[0]!.id,msg.id);
  assert.equal(first[0]!.state,"tool_offered");
  assert.equal(first[0]!.toolOffer?.offers,1);
  const lease={task,recipientId:"qa",messageId:msg.id};
  await assert.rejects(f.broker.claimForTransport(lease),/not claimable/);
  const second=await f.broker.offerToolInbox();
  assert.equal(second[0]!.id,msg.id);
  assert.equal(second[0]!.toolOffer?.offers,2);
  const offeredAt=second[0]!.toolOffer!.offeredAt;
  const call={task,recipientId:"qa",callId:"real-mcp-call",startedAt:offeredAt+1};
  await assert.rejects(f.broker.acknowledgeToolInbox(call),/Unverified subsequent tool call/);
  f.allowTool();
  assert.deepEqual(await f.broker.acknowledgeToolInbox({...call,startedAt:offeredAt}),[]);
  assert.deepEqual(await f.broker.acknowledgeToolInbox(call),[msg.id]);
  assert.deepEqual(await f.broker.acknowledgeToolInbox(call),[]);
  assert.equal((await f.store.load())!.messages[0]!.state,"acked");
});

test("CoS finish-tool offer is not implicitly ACKed by a lost finish retry", async t=>{
  const f=await fixture();t.after(f.close);await f.broker.initialize();
  await f.broker.admit({id:"qa",role:"qa",sessionFingerprint:"qa-proof"});
  const msg=await f.broker.send({to:"qa",kind:"work",body:"one",idempotencyKey:"offer-finish-01"});
  f.as("qa");await f.broker.bindSession("qa-authenticated-c");
  const offered=await f.broker.offerToolInbox(32000,true);
  assert.equal(offered.length,1);
  f.allowTool();
  const call={task,recipientId:"qa",callId:"finish-duplicate",startedAt:offered[0]!.toolOffer!.offeredAt+1,byFinish:true};
  assert.deepEqual(await f.broker.acknowledgeToolInbox(call),[]);
  assert.equal((await f.store.load())!.messages[0]!.state,"tool_offered");
  assert.deepEqual(await f.broker.acknowledgeToolInbox({...call,callId:"ordinary-call",byFinish:false}),[msg.id]);
});

test("CoS worker finish sleeps exact conversation; same-key report is idempotent and peer wake reserves slot", async t => {
  const f=await fixture();t.after(f.close);await f.broker.initialize();
  await f.broker.admit({id:"qa",role:"qa",sessionFingerprint:"qa-proof"});
  const assigned=await f.broker.send({to:"qa",kind:"work",body:"Review code",idempotencyKey:"assigned-qa-001"});
  f.as("qa");await f.broker.bindSession("persisted-original-qa-chat");
  await f.broker.claimForDelivery(assigned.id);
  f.allowReceipt();
  await f.broker.confirmDelivery({task,messageId:assigned.id,providerMessageId:"provider-original-turn"});
  await f.broker.acknowledge(assigned.id);
  const report=await f.broker.finishWork({result:"Found defect",idempotencyKey:"report-qa-001"});
  assert.equal(report.to,"main_agent");
  assert.equal((await f.store.load())!.agents.find(a=>a.id==="qa")?.status,"sleeping");
  const repeat=await f.broker.finishWork({result:"Found defect",idempotencyKey:"report-qa-001"});
  assert.equal(repeat.id,report.id);
  await assert.rejects(f.broker.send({to:"main_agent",kind:"work",body:"illegal",idempotencyKey:"sleep-send-01"}),/Sender is not executing work/);
  f.as("main_agent","owner-proof");
  const work=await f.broker.send({to:"qa",kind:"work",body:"Recheck fix",idempotencyKey:"recheck-qa-01"});
  const duplicate=await f.broker.send({to:"qa",kind:"work",body:"Recheck fix",idempotencyKey:"recheck-qa-01"});
  assert.equal(duplicate.id,work.id);
  assert.equal((await f.store.load())!.agents.find(a=>a.id==="qa")?.status,"waking");
  await assert.rejects(f.broker.send({to:"qa",kind:"work",body:"new job",idempotencyKey:"recheck-qa-02"}),/Recipient cannot accept another wake/);
  const lease={task,recipientId:"qa",messageId:work.id};
  const beforeClaim=await f.store.load();
  assert.deepEqual(beforeClaim!.messages.filter(m=>m.to==="qa").map(m=>[m.id,m.state]),
    [[assigned.id,"acked"],[work.id,"queued"]]);
  await f.broker.claimForTransport(lease);
  await f.broker.confirmTransportDelivery(lease,{task,messageId:work.id,providerMessageId:"provider-revival"});
  f.as("qa");await f.broker.acknowledge(work.id);
  const state=await f.store.load();
  assert.equal(state!.agents.find(a=>a.id==="qa")?.status,"busy");
  assert.equal(state!.agents.find(a=>a.id==="qa")?.sessionId,"persisted-original-qa-chat");
});

test("CoS wake slot quota atomically rejects a second sleeping worker",async t=>{
  const limited: typeof policy={...policy,maxActiveWorkers:1};
  const f=await fixture(limited);t.after(f.close);await f.broker.initialize();
  await f.broker.admit({id:"qa",role:"qa",sessionFingerprint:"qa-proof"});
  await f.broker.admit({id:"sec",role:"security",sessionFingerprint:"sec-proof"});
  f.as("qa");await f.broker.bindSession("original-qa");
  await f.broker.finishWork({result:"QA done",idempotencyKey:"qa-slot-done-01"});
  f.as("sec");await f.broker.bindSession("original-sec");
  await f.broker.finishWork({result:"Security done",idempotencyKey:"sec-slot-done-1"});
  f.as("main_agent","owner-proof");
  const msg=await f.broker.send({to:"qa",kind:"work",body:"review again",idempotencyKey:"qa-revive-001"});
  await assert.rejects(f.broker.send({to:"sec",kind:"work",body:"audit again",idempotencyKey:"sec-revive-01"}),/NO_FREE_SLOT/);
  const state=await f.store.load();
  assert.equal(state!.agents.find(a=>a.id==="qa")?.status,"waking");
  assert.equal(state!.agents.find(a=>a.id==="sec")?.status,"sleeping");
  assert.equal(state!.messages.filter(m=>m.to==="qa" && m.id===msg.id).length,1);
});

test("CoS two-stage spawn fences uncertain bootstrap and binds only exact host-proved session",async t=>{
  const f=await fixture();t.after(f.close);await f.broker.initialize();
  f.as("main_agent","owner-proof");
  // Default-deny: the old trust implementation has no independent bootstrap grant.
  const reserved=await f.broker.requestSpawn({id:"qa-new",role:"qa",idempotencyKey:"staged-qa-00001"});
  assert.equal(reserved.state,"reserved");
  assert.equal((await f.store.load())!.agents.some(a=>a.id==="qa-new"),false);
  const same=await f.broker.requestSpawn({id:"qa-new",role:"qa",idempotencyKey:"staged-qa-00001"});
  assert.equal(same.id,reserved.id);
  await assert.rejects(f.broker.claimSpawnBootstrap({task,agentId:"qa-new",idempotencyKey:"staged-qa-00001"}),/Unverified spawn bootstrap lease/);
  await assert.rejects(f.broker.bindSpawn({task,agentId:"qa-new",idempotencyKey:"staged-qa-00001"},
    {sessionId:"unauthorized",sessionFingerprint:"qa-new-proof"}),/Unverified spawned provider identity/);
  assert.equal((await f.store.load())!.pendingSpawns?.[0]?.state,"reserved");
});

test("CoS staged spawn survives crash, rejects replay, retains exact original binding",async t=>{
  const root=await mkdtemp(join(tmpdir(),"staged-bootstrap-"));t.after(async()=>rm(root,{recursive:true,force:true}));
  let actor: VerifiedDynamicCaller={task,agentId:"main_agent",sessionFingerprint:"owner"};
  let leaseOk=true,providerOk=true,recoveryOk=false;
  const trust={
    resolveCaller:async()=>actor,verifyPolicy:async()=>true,
    verifyNewAgentBinding:async(input:{id:string;role:string;sessionFingerprint:string})=>
      providerOk&&input.id==="qa-new"&&input.role==="qa"&&input.sessionFingerprint==="qa-proven",
    verifyToolCall:async()=>true,verifyTransportLease:async()=>true,
    verifyProviderReceipt:async()=>true,verifyNoSubmit:async()=>true,
    verifySpawnLease:async()=>leaseOk,verifySpawnNoStart:async()=>recoveryOk,
  };
  const store=new DynamicAgentStore(root,task);
  const broker=new DynamicAgentBroker(policy,store,trust);
  await broker.initialize();
  const req={id:"qa-new",role:"qa",idempotencyKey:"qa-bootstrap-001"};
  const lease={task,agentId:req.id,idempotencyKey:req.idempotencyKey};
  await broker.requestSpawn(req);
  await broker.claimSpawnBootstrap(lease);
  await assert.rejects(broker.claimSpawnBootstrap(lease),/already claimed/);
  const recovered=new DynamicAgentBroker(policy,new DynamicAgentStore(root,task),trust);
  await assert.rejects(recovered.releaseUnstartedSpawn({...lease,evidenceId:"fake"}),/Missing independent no-bootstrap proof/);
  await assert.rejects(recovered.claimSpawnBootstrap(lease),/already claimed/);
  providerOk=false;
  await assert.rejects(recovered.bindSpawn(lease,{sessionId:"wrong",sessionFingerprint:"qa-proven"}),/Unverified spawned provider identity/);
  providerOk=true;
  const member=await recovered.bindSpawn(lease,{sessionId:"https://chatgpt.com/c/saved-qa",sessionFingerprint:"qa-proven"});
  assert.equal(member.id,"qa-new");
  assert.equal(member.status,"idle");
  assert.equal((await store.load())!.pendingSpawns?.[0]?.state,"bound");
  const duplicate=await recovered.bindSpawn(lease,{sessionId:member.sessionId!,sessionFingerprint:"qa-proven"});
  assert.equal(duplicate.sessionId,member.sessionId);
  await assert.rejects(recovered.bindSpawn(lease,{sessionId:"https://chatgpt.com/c/other-chat",sessionFingerprint:"qa-proven"}),/Spawn binding conflict/);
  leaseOk=false;
  await assert.rejects(recovered.bindSpawn(lease,{sessionId:member.sessionId!,sessionFingerprint:"qa-proven"}),/Unverified spawned provider identity/);
  assert.equal((await store.load())!.agents.filter(a=>a.id==="qa-new").length,1);
});

test("CoS host-proved pre-bootstrap release never silently retries unknown spawned chat",async t=>{
  const root=await mkdtemp(join(tmpdir(),"spawn-no-start-"));t.after(async()=>rm(root,{recursive:true,force:true}));
  let allowRelease=false;
  const trust={
    resolveCaller:async()=>({task,agentId:"main_agent",sessionFingerprint:"owner"}),
    verifyPolicy:async()=>true,verifyNewAgentBinding:async()=>true,
    verifyToolCall:async()=>true,verifyTransportLease:async()=>true,
    verifyProviderReceipt:async()=>true,verifyNoSubmit:async()=>true,
    verifySpawnLease:async()=>true,verifySpawnNoStart:async()=>allowRelease,
  };
  const broker=new DynamicAgentBroker(policy,new DynamicAgentStore(root,task),trust);
  await broker.initialize();
  const idempotencyKey="qa-unknown-00001";
  await broker.requestSpawn({id:"qa-new",role:"qa",idempotencyKey});
  const lease={task,agentId:"qa-new",idempotencyKey};
  await broker.claimSpawnBootstrap(lease);
  await assert.rejects(broker.claimSpawnBootstrap(lease),/already claimed/);
  await assert.rejects(broker.releaseUnstartedSpawn({...lease,evidenceId:"host-observed-no-start"}),/Missing independent/);
  allowRelease=true;
  await broker.releaseUnstartedSpawn({...lease,evidenceId:"host-observed-no-start"});
  assert.equal((await broker.status()).agents.length,1);
  const claim=await broker.claimSpawnBootstrap(lease);
  assert.equal(claim.state,"bootstrap_uncertain");
});
