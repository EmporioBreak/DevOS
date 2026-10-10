import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import test from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ChatAccessRegistry} from "../src/chat-access.js";
import {OwnerTaskApprovalStore} from "../src/owner-task-approval.js";
import {OwnerWakeupLedger} from "../src/owner-wakeup-ledger.js";
import {enqueueOwnerHandoff} from "../src/owner-wakeup-handoff.js";
import type {RunState} from "../src/orchestrator.js";
import type {Workflow} from "../src/workflow.js";

const repo="EmporioBreak/DevOS";
const workflow:Workflow={version:1,task:{repo,issue:224,pr:225},owner:{mode:"main_agent"},
  start:"developer",workers:[
    {id:"developer",executor:"chatgpt_browser",prompt:"approved action",on:{done:"reviewer"}},
    {id:"reviewer",executor:"chatgpt_browser",prompt:"independent review",on:{approved:null}},
  ]};
const pending=(overrides:Partial<RunState>={}):RunState=>({
  task:workflow.task,currentWorkerId:"reviewer",completedRuns:2,reviewLoops:0,
  sessions:{developer:"https://chatgpt.com/c/worker1",reviewer:"https://chatgpt.com/c/worker2"},
  mainAgentReviewPending:true,...overrides,
});
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"devos-owner-handoff-"));
  const secret="owner-wakeup-integration-"+randomBytes(32).toString("hex");
  const password="approved-form-password";
  const chats=new ChatAccessRegistry(root,secret),fingerprint=chats.fingerprint("oauth-client","host-owner-session");
  chats.approve(fingerprint,"https://chatgpt.com/share/7bc799bd-7ffc-83eb-b2b0-15d6a2f558a0");
  const store=new OwnerTaskApprovalStore(root,secret,chats,password);
  const review={repo,issue:224,pr:225,gitSha:"e".repeat(40),constitutionSha:"a".repeat(64),
    approvals:[{kind:"constitution" as const,digest:"a".repeat(64)},
      {kind:"scope" as const,digest:"b".repeat(64)},{kind:"spec" as const,digest:"b".repeat(64)},
      {kind:"plan" as const,digest:"b".repeat(64)}]};
  const ledger=new OwnerWakeupLedger(root,secret);
  const signed=()=>{const ticket=store.issue(fingerprint,review);assert.ok(ticket.ready);
    assert.equal(store.submit({ticket:ticket.ticket,password,confirm:"approve"}),true);};
  return {root,store,chats,ledger,fingerprint,signed};
}

test("no owner notification before durable final review or from a different task",async()=>{
  const f=await fixture();
  try{
    f.signed();
    for(const state of [pending({mainAgentReviewPending:false}),pending({completionApproved:true}),
      pending({task:{repo,issue:226,pr:227}}),pending({completedRuns:0}),
      pending({sessions:{}})]){
      assert.equal(await enqueueOwnerHandoff({workflow,state,store:f.store,ledger:f.ledger}),"not_due");
    }
    assert.equal(await f.ledger.status(workflow.task,0),null);
  }finally{await rm(f.root,{recursive:true,force:true})}
});

test("signed exact owner approval queues one notice, never a provider send, per real final-review round",async()=>{
  const f=await fixture();
  try{
    assert.equal(await enqueueOwnerHandoff({workflow,state:pending(),store:f.store,ledger:f.ledger}),"no_binding");
    f.signed();
    assert.equal(await enqueueOwnerHandoff({workflow,state:pending(),store:f.store,ledger:f.ledger}),"waiting");
    assert.equal(await enqueueOwnerHandoff({workflow,state:pending(),store:f.store,ledger:f.ledger}),"waiting");
    assert.equal(await f.ledger.arm(workflow.task,0),true);
    assert.equal(await enqueueOwnerHandoff({workflow,state:pending(),store:f.store,ledger:f.ledger}),"armed",
      "same saved handoff must never reset an attempted send");
    assert.equal(await enqueueOwnerHandoff({workflow,state:pending({reviewLoops:1,completedRuns:4}),
      store:f.store,ledger:f.ledger}),"waiting");
    assert.equal(await f.ledger.status(workflow.task,1),"waiting");
    f.chats.revoke(f.fingerprint);
    assert.equal(await enqueueOwnerHandoff({workflow,state:pending({reviewLoops:2,completedRuns:6}),
      store:f.store,ledger:f.ledger}),"no_binding");
  }finally{await rm(f.root,{recursive:true,force:true})}
});

test("unapproved workflows and ambiguous signed owner revisions never produce a notification",async()=>{
  const f=await fixture();
  try{
    f.signed();
    const wrong={...workflow,task:{repo,issue:224,pr:226}};
    assert.equal(await enqueueOwnerHandoff({workflow:wrong,state:pending({task:wrong.task}),
      store:f.store,ledger:f.ledger}),"no_binding");
    const {owner:_owner,...unowned}=workflow;
    assert.equal(await enqueueOwnerHandoff({workflow:unowned,state:pending(),
      store:f.store,ledger:f.ledger}),"not_due");
  }finally{await rm(f.root,{recursive:true,force:true})}
});
