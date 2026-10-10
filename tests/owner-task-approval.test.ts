import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {chmodSync,readFileSync,writeFileSync,existsSync} from "node:fs";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {ChatAccessRegistry} from "../src/chat-access.js";
import {OwnerTaskApprovalStore, trustedTaskApprovalVerifier, ownerTaskApprovalForm} from "../src/owner-task-approval.js";

const secret="local-test-"+randomBytes(32).toString("hex");
const password="form-password-"+randomBytes(24).toString("hex");
const a="a".repeat(64),b="b".repeat(64),c="c".repeat(64),d="d".repeat(64);
const review=()=>({repo:"EmporioBreak/DevOS",issue:214,pr:215,
  gitSha:"e".repeat(40),constitutionSha:a,approvals:[
    {kind:"constitution" as const,digest:a},
    {kind:"scope" as const,digest:b},
    {kind:"spec" as const,digest:b},
    {kind:"plan" as const,digest:b},
    {kind:"plan" as const,digest:c},
    {kind:"plan" as const,digest:d},
  ]});
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"devos-owner-approval-"));
  const chats=new ChatAccessRegistry(root,secret);
  const owner=chats.fingerprint("client-owner","host-session-owner");
  const stranger=chats.fingerprint("client-owner","host-session-other");
  chats.approve(owner,"https://chatgpt.com/c/6ac799bd-7ffc-83eb-b2b0-15d6a2f558a0");
  const store=new OwnerTaskApprovalStore(root,secret,chats,password);
  return {root,chats,store,owner,stranger};
}
test("password-submitted owner review survives restart and binds all exact digests",async()=>{
  const f=await fixture();
  try{
    assert.deepEqual(f.store.issue(f.stranger,review()),{ready:false,reason:"owner_chat_required"});
    assert.deepEqual(f.store.issue(undefined,review()),{ready:false,reason:"owner_chat_required"});
    const issued=f.store.issue(f.owner,review());
    assert.equal(issued.ready,true);
    const ticket=issued.ticket!;
    assert.match(ticket,/^[A-Za-z0-9_-]{32}$/);
    assert.deepEqual(f.store.preview(ticket),review());
    assert.equal(f.store.issue(f.owner,review()).ticket,ticket);
    assert.equal(f.store.issue(f.owner,{...review(),gitSha:"f".repeat(40)}).reason,"different_review_pending");
    assert.deepEqual(f.store.result(ticket,f.stranger),{approved:false});
    assert.equal(f.store.submit({ticket,password:"wrong",confirm:"approve"}),false);
    assert.equal(f.store.submit({ticket,password,confirm:"approve"}),true);
    assert.equal(f.store.submit({ticket,password,confirm:"approve"}),false);
    assert.equal(f.store.preview(ticket),null);
    const ref=f.store.result(ticket,f.owner).approval_ref!;
    assert.match(ref,/^devos-owner-approval:[0-9a-f-]{36}$/);
    const restarted=new OwnerTaskApprovalStore(f.root,secret,f.chats,password);
    const verifier=trustedTaskApprovalVerifier(restarted,review());
    for(const item of review().approvals.filter(x=>x.kind!=="constitution"))
      assert.equal(await verifier({userMessageRef:ref,kind:item.kind,
        reviewedDigest:item.digest},{kind:item.kind,digest:item.digest}),true);
    assert.equal(await verifier({userMessageRef:ref,kind:"plan",reviewedDigest:"0".repeat(64)},
      {kind:"plan",digest:"0".repeat(64)}),false);
    assert.equal(await verifier({userMessageRef:ref,kind:"plan",reviewedDigest:c},
      {kind:"scope",digest:c}),false);
    assert.equal(restarted.verify(ref,{kind:"plan",digest:c},{...review(),issue:999}),false);
    assert.equal(restarted.verify(ref,{kind:"plan",digest:c},{...review(),gitSha:"f".repeat(40)}),false);
    assert.equal(restarted.verify("devos-owner-approval:"+ "0".repeat(36),
      {kind:"plan",digest:c},review()),false);
    assert.equal(restarted.verify("model-authored-message", {kind:"plan",digest:c},review()),false);
    const id=ref.split(":")[1],file=join(f.root,".devos","owner-approvals",id+".json");
    const original=readFileSync(file,"utf8");
    assert.equal(existsSync(file),true);
    assert.equal(readFileSync(file,"utf8").includes(password),false);
    writeFileSync(file,original.replace("\"issue\":214","\"issue\":215"));
    assert.equal(restarted.verify(ref,{kind:"plan",digest:c},review()),false,"tampered signed receipt");
    writeFileSync(file,original);
    chmodSync(file,0o644);
    assert.equal(restarted.verify(ref,{kind:"plan",digest:c},review()),false,"world-readable receipt");
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test("wrong password capped, replay and expiry fail closed",async()=>{
  const f=await fixture();
  try{
    const ticket=f.store.issue(f.owner,review()).ticket!;
    assert.equal(f.store.submit({ticket,password:"bad",confirm:"approve"}),false);
    assert.equal(f.store.submit({ticket,password:"bad",confirm:"approve"}),false);
    assert.equal(f.store.submit({ticket,password:"bad",confirm:"approve"}),false);
    assert.equal(f.store.submit({ticket,password,confirm:"approve"}),false);
    assert.equal(f.store.preview(ticket),null);
    const valid=f.store.issue(f.owner,review()).ticket!;
    const old=Date.now;Date.now=()=>old()+360_000;
    try{
      assert.equal(f.store.preview(valid),null);
      assert.equal(f.store.submit({ticket:valid,password,confirm:"approve"}),false);
    }finally{Date.now=old;}
    assert.deepEqual(f.store.result(valid,f.owner),{approved:false});
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test("revoked owner and malformed approval cannot sign a receipt",async()=>{
  const f=await fixture();
  try{
    assert.throws(()=>f.store.issue(f.owner,{...review(),approvals:[]}),/Malformed/);
    assert.throws(()=>f.store.issue(f.owner,{...review(),constitutionSha:"f".repeat(64)}),/Constitution/);
    const ticket=f.store.issue(f.owner,review()).ticket!;
    f.chats.revoke(f.owner);
    assert.equal(f.store.submit({ticket,password,confirm:"approve"}),false);
    assert.equal(f.store.preview(ticket),null);
    assert.deepEqual(f.store.result(ticket,f.owner),{approved:false});
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test("external review form shows exact scope and never embeds credentials",()=>{
  const html=ownerTaskApprovalForm();
  assert.match(html,/Утверждаю точно указанные версии/);
  assert.match(html,/Constitution SHA/);
  assert.match(html,/GitHub/);
  assert.match(html,/password/);
  assert.match(html,/credentials:"omit"/);
  assert.ok(!html.includes(secret)&&!html.includes(password));
});

test("owner wake-up target is the exact password-signed approval chat, never the first registry binding",async()=>{
  const f=await fixture();
  try{
    const unrelated=f.chats.fingerprint("different-client","other-session");
    f.chats.approve(unrelated,"https://chatgpt.com/c/9ab799bd-7ffc-83eb-b2b0-15d6a2f558a0");
    assert.equal(f.store.resolveOwnerChat(review()),null,"chat registry grants are not owner task approval");
    const issued=f.store.issue(f.owner,review());
    assert.equal(issued.ready,true);
    assert.equal(f.store.submit({ticket:issued.ticket,password,confirm:"approve"}),true);
    assert.deepEqual(f.store.resolveOwnerChat(review()),{
      fingerprint:f.owner,approvedReference:"https://chatgpt.com/c/6ac799bd-7ffc-83eb-b2b0-15d6a2f558a0",
      kind:"private",
    });
    assert.equal(f.store.resolveOwnerChat({...review(),issue:999}),null,"same chat approval does not bind another Issue");
    f.chats.revoke(f.owner);
    assert.equal(f.store.resolveOwnerChat(review()),null,"revoked owner chat cannot receive wake-up");
  }finally{await rm(f.root,{recursive:true,force:true})}
});

test("owner wake-up preserves /share as a non-writable label and rejects multiple signed owners",async()=>{
  const f=await fixture();
  try{
    const share="https://chatgpt.com/share/7bc799bd-7ffc-83eb-b2b0-15d6a2f558a0";
    f.chats.revoke(f.owner);
    f.chats.approve(f.owner,share);
    const first=f.store.issue(f.owner,review());
    assert.equal(f.store.submit({ticket:first.ticket,password,confirm:"approve"}),true);
    assert.deepEqual(f.store.resolveOwnerChat(review()),{
      fingerprint:f.owner,approvedReference:share,kind:"share_label",
    },"public share must not be asserted to be an editable /c conversation");
    f.chats.approve(f.stranger,"https://chatgpt.com/c/8ac799bd-7ffc-83eb-b2b0-15d6a2f558a0");
    const second=f.store.issue(f.stranger,review());
    assert.equal(f.store.submit({ticket:second.ticket,password,confirm:"approve"}),true);
    assert.throws(()=>f.store.resolveOwnerChat(review()),/ambiguous|multiple/i,
      "multiple signed chat approvals for exact task must never be chosen arbitrarily");
  }finally{await rm(f.root,{recursive:true,force:true})}
});
