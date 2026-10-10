import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {OwnerWakeupLedger} from "../src/owner-wakeup-ledger.js";

const secret="owner-wakeup-local-test-secret-with-sufficient-entropy";
const task={repo:"EmporioBreak/DevOS",issue:224};
const fp="chat_"+"a".repeat(64);
const reference="https://chatgpt.com/share/7bc799bd-7ffc-83eb-b2b0-15d6a2f558a0";
const prompt="DevOS automated final review reminder: Issue #224";

test("one wake-up intent per signed owner + Issue review round with no raw chat/prompt on disk",async()=>{
  const root=await mkdtemp(join(tmpdir(),"devos-owner-wakeup-"));
  try{
    const q=new OwnerWakeupLedger(root,secret);
    assert.equal(await q.enqueue(task,0,fp,reference,prompt),"waiting");
    assert.equal(await q.enqueue(task,0,fp,reference,prompt),"waiting");
    const file=q.fileFor(task,0);
    const stored=await readFile(file,"utf8");
    assert.doesNotMatch(stored,/share\/|chatgpt\.com|automated final review reminder/);
    await assert.rejects(q.enqueue(task,0,fp,reference,prompt+" altered"),/conflicting|different/i);
    await assert.rejects(q.enqueue(task,0,"chat_"+"b".repeat(64),reference,prompt),/conflicting|different/i);
    assert.equal(await q.enqueue(task,1,fp,reference,prompt),"waiting","new explicitly requested review round is independent");
  }finally{await rm(root,{recursive:true,force:true})}
});

test("send is armed durably before click, survives restart and cannot replay ambiguous prior turn",async()=>{
  const root=await mkdtemp(join(tmpdir(),"devos-owner-wakeup-"));
  try{
    const a=new OwnerWakeupLedger(root,secret),b=new OwnerWakeupLedger(root,secret);
    await a.enqueue(task,0,fp,reference,prompt);
    const result=await Promise.allSettled([a.arm(task,0),b.arm(task,0)]);
    assert.equal(result.filter(x=>x.status==="fulfilled"&&x.value===true).length,1);
    assert.equal(await new OwnerWakeupLedger(root,secret).arm(task,0),false);
    assert.equal(await b.status(task,0),"armed");
    assert.equal(await b.markAmbiguous(task,0),"ambiguous");
    assert.equal(await a.arm(task,0),false,"possible-send never blindly retries");
    assert.equal(await a.enqueue(task,1,fp,reference,prompt),"waiting",
      "another true final-review round is a separate notification");
  }finally{await rm(root,{recursive:true,force:true})}
});

test("only trusted provider receipt may confirm a send, with strict task and HMAC integrity",async()=>{
  const root=await mkdtemp(join(tmpdir(),"devos-owner-wakeup-"));
  try{
    const q=new OwnerWakeupLedger(root,secret);
    await q.enqueue(task,0,fp,reference,prompt);
    await q.arm(task,0);
    await assert.rejects(q.confirm(task,0,"user-message-one",async()=>false),/provider|receipt/i);
    assert.equal(await q.status(task,0),"armed");
    assert.equal(await q.confirm(task,0,"user-message-one",async()=>true),"confirmed");
    assert.equal(await q.arm(task,0),false);
    const wrong=new OwnerWakeupLedger(root,"wrong-owner-secret-but-still-long-enough");
    await assert.rejects(wrong.status(task,0),/integrity|MAC|signature/i);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("notification deadline and cancellation are bounded without replacing an armed attempt",async()=>{
  const root=await mkdtemp(join(tmpdir(),"devos-owner-wakeup-"));
  const actual=Date.now;
  try{
    const q=new OwnerWakeupLedger(root,secret);
    await q.enqueue(task,0,fp,reference,prompt);
    const now=actual();
    Date.now=()=>now+16*60_000;
    assert.equal(await q.arm(task,0),false,"expired pending send must not click");
    assert.equal(await q.status(task,0),"blocked");
    assert.equal(await q.arm(task,0),false);
    Date.now=actual;
    await q.enqueue(task,1,fp,reference,prompt);
    assert.equal(await q.cancel(task,1),"blocked","pending cancellation is terminal");
    await q.enqueue(task,2,fp,reference,prompt);
    assert.equal(await q.arm(task,2),true);
    assert.equal(await q.cancel(task,2),"ambiguous","cancel after arming cannot assert no-submit");
    assert.equal(await q.arm(task,2),false,"armed attempt cannot be resent");
  }finally{Date.now=actual;await rm(root,{recursive:true,force:true})}
});
